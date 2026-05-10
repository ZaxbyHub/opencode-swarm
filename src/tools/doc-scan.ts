import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { DocsConfigSchema } from '../config/schema.js';
import {
	appendKnowledge,
	findNearDuplicate,
	jaccardBigram,
	normalize,
	readKnowledge,
	resolveSwarmKnowledgePath,
	wordBigrams,
} from '../hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
import { createSwarmTool } from './create-tool.js';

// ============ Types ============
export interface DocManifestFile {
	path: string; // relative to project root
	title: string; // first # heading or filename
	summary: string; // first non-empty paragraph (max 200 chars)
	lines: number; // total line count of the file
	mtime: number; // fs.statSync().mtimeMs for cache invalidation
}

export interface DocManifest {
	schema_version: 1;
	scanned_at: string; // ISO timestamp
	files: DocManifestFile[];
}

// ============ Constants ============
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'.swarm',
	'dist',
	'build',
	'.next',
	'vendor',
	// Bazel output trees
	'bazel-out',
	'bazel-bin',
	'bazel-genfiles',
	'bazel-testlogs',
	// Gradle / Maven / Rust Cargo output trees
	'.gradle',
	'target',
]);

const SKIP_PATTERNS = [/\.test\./, /\.spec\./, /\.d\.ts$/];

const MAX_SUMMARY_LENGTH = 200;
const MAX_INDEXED_FILES = 100;
const READ_LINES_LIMIT = 30;

// Pass 2 constants
const MIN_LESSON_LENGTH = 15;
const MAX_CONSTRAINTS_PER_DOC = 5;
const MAX_CONSTRAINT_LENGTH = 200;
const RELEVANCE_THRESHOLD = 0.1; // Minimum Jaccard similarity to be considered relevant
const DEDUP_THRESHOLD = 0.6; // Same as knowledge-store default

// ============ Helper Functions ============

/**
 * Normalize path separators to forward slashes for consistent matching
 */
function normalizeSeparators(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

/**
 * Check if a file path matches any of the given doc patterns
 */
function matchesDocPattern(filePath: string, patterns: string[]): boolean {
	const normalizedPath = normalizeSeparators(filePath);
	const basename = path.basename(filePath);

	for (const pattern of patterns) {
		// Pattern has no "/" → exact filename match (e.g., "README.md")
		if (!pattern.includes('/') && !pattern.includes('\\')) {
			if (basename === pattern) {
				return true;
			}
			continue;
		}

		// Pattern starts with **/ → filename match after **/ (e.g., "**/CHANGELOG.md")
		if (pattern.startsWith('**/')) {
			const filenamePattern = pattern.slice(3);
			if (basename === filenamePattern) {
				return true;
			}
			continue;
		}

		// Pattern has directory prefix (e.g., "docs/**/*.md", ".github/*.md", "doc/**/*.md")
		// Check if file path starts with that directory prefix
		const patternNormalized = normalizeSeparators(pattern);
		// Remove trailing patterns like /** or /**
		const dirPrefix = patternNormalized
			.replace(/\/\*\*.*$/, '')
			.replace(/\/\*.*$/, '');

		if (
			normalizedPath.startsWith(`${dirPrefix}/`) ||
			normalizedPath === dirPrefix
		) {
			return true;
		}
	}

	return false;
}

/**
 * Extract title and summary from markdown content
 */
function extractTitleAndSummary(
	content: string,
	filename: string,
): { title: string; summary: string } {
	const lines = content.split('\n');

	let title = filename; // Default to filename
	let summary = '';
	let foundTitle = false;

	// First pass: find title (first # heading) and collect non-heading lines for summary
	const potentialSummaryLines: string[] = [];

	for (let i = 0; i < lines.length && i < READ_LINES_LIMIT; i++) {
		const line = lines[i].trim();

		// Extract title from first # heading
		if (!foundTitle && line.startsWith('# ')) {
			title = line.slice(2).trim();
			foundTitle = true;
			continue;
		}

		// Collect non-heading, non-empty lines for summary
		if (line && !line.startsWith('#')) {
			potentialSummaryLines.push(line);
		}
	}

	// Build summary from first continuous paragraph
	for (const line of potentialSummaryLines) {
		summary += (summary ? ' ' : '') + line;
		if (summary.length >= MAX_SUMMARY_LENGTH) {
			break;
		}
	}

	// Truncate if needed
	if (summary.length > MAX_SUMMARY_LENGTH) {
		summary = `${summary.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
	}

	return { title, summary };
}

/**
 * Strip markdown formatting from text
 */
function stripMarkdown(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove [text](url) links, keep text
		.replace(/\*\*([^*]+)\*\*/g, '$1') // Remove **bold**, keep text
		.replace(/`([^`]+)`/g, '$1') // Remove `code`, keep text
		.replace(/^\s*[-*•]\s+/gm, '') // Remove list markers
		.replace(/^\s*\d+\.\s+/gm, '') // Remove numbered list markers
		.trim();
}

// ============ Main Scan Function ============

export async function scanDocIndex(
	directory: string,
): Promise<{ manifest: DocManifest; cached: boolean }> {
	const manifestPath = path.join(directory, '.swarm', 'doc-manifest.json');

	// Get doc patterns from config defaults plus extras
	const defaultPatterns = DocsConfigSchema.parse({}).doc_patterns;
	const extraPatterns = [
		'ARCHITECTURE.md',
		'CLAUDE.md',
		'AGENTS.md',
		'.github/*.md',
		'doc/**/*.md',
	];
	const allPatterns = [...defaultPatterns, ...extraPatterns];

	// Check for existing manifest (cache validation)
	try {
		const manifestContent = await readFile(manifestPath, 'utf-8');
		const existingManifest: DocManifest = JSON.parse(manifestContent);

		if (existingManifest.schema_version === 1 && existingManifest.files) {
			let cacheValid = true;

			// Check each file's mtime
			for (const file of existingManifest.files) {
				try {
					const fullPath = path.join(directory, file.path);
					const stat = fs.statSync(fullPath);

					if (stat.mtimeMs > file.mtime) {
						cacheValid = false;
						break;
					}
				} catch {
					// File no longer exists - invalidate cache
					cacheValid = false;
					break;
				}
			}

			if (cacheValid) {
				return { manifest: existingManifest, cached: true };
			}
		}
	} catch {
		// No existing manifest or parse error - need to rescan
	}

	// Perform fresh scan using an async pruning directory walk.
	// Directories in SKIP_DIRECTORIES are skipped before descent, so large
	// build output trees (bazel-out, bazel-bin, node_modules, target, etc.)
	// are never traversed. This avoids the synchronous event-loop block that
	// readdirSync({recursive:true}) causes in monorepos with millions of files.
	const resolvedDirectory = await realpath(directory).catch(() => directory);
	const discoveredFiles: DocManifestFile[] = [];
	let rootReadable = false;

	const walkDir = async (dir: string): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
			if (dir === directory) rootReadable = true;
		} catch {
			return; // permission error — skip subtree
		}

		for (const entry of entries) {
			// Stop processing as soon as the cap is reached — avoids stat-ing and
			// reading files that will be discarded by the post-walk splice.
			if (discoveredFiles.length >= MAX_INDEXED_FILES) return;

			const isDir = entry.isDirectory();
			let isFile = entry.isFile();

			// Follow symlinks for files so symlinked docs are indexed, matching
			// the old readdirSync({recursive:true}) + statSync behavior.
			// Directory symlinks are intentionally NOT followed to avoid cycles.
			// realpath() resolves the canonical target path and enforces that it
			// stays inside the project root, preventing traversal to /etc/passwd etc.
			if (entry.isSymbolicLink()) {
				try {
					const symlinkPath = path.join(dir, entry.name);
					const resolved = await realpath(symlinkPath);
					const rel = path.relative(resolvedDirectory, resolved);
					// Reject if the target escapes the project root
					if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
					const targetStat = await stat(symlinkPath);
					isFile = targetStat.isFile();
					// isDir stays false — don't recurse into symlinked directories
				} catch {
					continue; // broken symlink or unresolvable — skip
				}
			}

			if (isDir) {
				if (!SKIP_DIRECTORIES.has(entry.name)) {
					await walkDir(path.join(dir, entry.name));
				}
				continue;
			}

			if (!isFile) continue;

			const fullPath = path.join(dir, entry.name);
			const relPath = normalizeSeparators(path.relative(directory, fullPath));

			// Skip test and type definition files
			let skipThisFile = false;
			for (const pattern of SKIP_PATTERNS) {
				if (pattern.test(relPath)) {
					skipThisFile = true;
					break;
				}
			}
			if (skipThisFile) continue;

			// Only process files that match doc patterns
			if (!matchesDocPattern(relPath, allPatterns)) continue;

			// Get mtime for cache invalidation
			let fileStat: fs.Stats;
			try {
				fileStat = await stat(fullPath);
			} catch {
				continue;
			}

			// Read file content to extract title and summary
			let content: string;
			try {
				content = await readFile(fullPath, 'utf-8');
			} catch {
				continue;
			}

			const { title, summary } = extractTitleAndSummary(
				content,
				path.basename(relPath),
			);

			discoveredFiles.push({
				path: relPath,
				title,
				summary,
				lines: content.split('\n').length,
				mtime: fileStat.mtimeMs,
			});
		}
	};

	await walkDir(directory);

	// If the root directory was unreadable, return an empty manifest without
	// caching it — matches the old readdirSync early-return behavior so a
	// transient permission error does not poison the cache.
	if (!rootReadable) {
		return {
			manifest: {
				schema_version: 1,
				scanned_at: new Date().toISOString(),
				files: [],
			},
			cached: false,
		};
	}

	// Sort files by path (case-insensitive)
	discoveredFiles.sort((a, b) =>
		a.path.toLowerCase().localeCompare(b.path.toLowerCase()),
	);

	// Limit number of indexed files
	let truncated = false;
	if (discoveredFiles.length > MAX_INDEXED_FILES) {
		discoveredFiles.splice(MAX_INDEXED_FILES);
		truncated = true;
	}

	// Add truncated warning to first file's summary if needed
	if (truncated && discoveredFiles.length > 0) {
		discoveredFiles[0].summary =
			`[Warning: ${MAX_INDEXED_FILES}+ docs found, listing first ${MAX_INDEXED_FILES}] ` +
			discoveredFiles[0].summary;
	}

	// Build manifest
	const manifest: DocManifest = {
		schema_version: 1,
		scanned_at: new Date().toISOString(),
		files: discoveredFiles,
	};

	// Write manifest to disk
	try {
		await mkdir(path.dirname(manifestPath), { recursive: true });
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	} catch {
		// Failed to write manifest - still return the manifest
	}

	return { manifest, cached: false };
}

// ============ Pass 2: Extract Constraints ============

/**
 * Actionable constraint patterns for extraction
 */
const CONSTRAINT_PATTERNS = [
	/\bMUST\b/,
	/\bMUST NOT\b/,
	/\bSHOULD\b/,
	/\bSHOULD NOT\b/,
	/\bDO NOT\b/,
	/\bALWAYS\b/,
	/\bNEVER\b/,
	/\bREQUIRED\b/,
];

/**
 * Action word patterns for bullet point extraction
 */
const ACTION_WORDS = /\b(must|should|don't|avoid|ensure|use|follow)\b/i;

/**
 * Check if a line contains actionable constraints
 */
function isConstraintLine(line: string): boolean {
	const upperLine = line.toUpperCase();
	for (const pattern of CONSTRAINT_PATTERNS) {
		if (pattern.test(upperLine)) {
			return true;
		}
	}
	// Check bullet points with action words
	if (/^\s*[-*•]/.test(line) && ACTION_WORDS.test(line)) {
		return true;
	}
	return false;
}

/**
 * Extract actionable constraints from documentation content
 */
function extractConstraintsFromContent(content: string): string[] {
	const lines = content.split('\n');
	const constraints: string[] = [];

	for (const line of lines) {
		if (constraints.length >= MAX_CONSTRAINTS_PER_DOC) {
			break;
		}

		const trimmed = line.trim();
		if (!trimmed) continue;

		if (isConstraintLine(trimmed)) {
			const cleaned = stripMarkdown(trimmed);
			const len = cleaned.length;
			if (len >= MIN_LESSON_LENGTH && len <= MAX_CONSTRAINT_LENGTH) {
				constraints.push(cleaned);
			}
		}
	}

	return constraints;
}

/**
 * Extract actionable constraints from project documentation relevant to a task.
 *
 * Algorithm:
 * 1. Read .swarm/doc-manifest.json (or generate via scanDocIndex if missing)
 * 2. Score each doc against task files + description using Jaccard bigram similarity
 * 3. For docs with score > RELEVANCE_THRESHOLD, read full content and extract constraints
 * 4. Dedup against existing knowledge entries before appending
 * 5. Return extraction statistics
 */
export async function extractDocConstraints(
	directory: string,
	taskFiles: string[],
	taskDescription: string,
): Promise<{
	extracted: number;
	skipped: number;
	details: { path: string; score: number; constraints: string[] }[];
}> {
	// Step 1: Get or generate manifest
	const manifestPath = path.join(directory, '.swarm', 'doc-manifest.json');
	let manifest: DocManifest;

	try {
		const content = await readFile(manifestPath, 'utf-8');
		manifest = JSON.parse(content);
	} catch {
		// Manifest not found, generate it
		const result = await scanDocIndex(directory);
		manifest = result.manifest;
	}

	// Step 2: Read existing knowledge entries to prevent duplicates
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	const existingEntries =
		await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);

	// Step 3: Build task context for scoring
	const taskContext = [...taskFiles, taskDescription].join(' ');
	const taskBigrams = wordBigrams(normalize(taskContext));

	let extractedCount = 0;
	let skippedCount = 0;
	const details: { path: string; score: number; constraints: string[] }[] = [];

	// Step 4: Score and process each doc
	for (const docFile of manifest.files) {
		// Compute relevance score
		const docContext = `${docFile.path} ${docFile.title} ${docFile.summary}`;
		const docBigrams = wordBigrams(normalize(docContext));
		const score = jaccardBigram(taskBigrams, docBigrams);

		if (score <= RELEVANCE_THRESHOLD) {
			skippedCount++;
			continue;
		}

		// Read full content for relevant docs
		let fullContent: string;
		try {
			fullContent = await readFile(path.join(directory, docFile.path), 'utf-8');
		} catch {
			// Missing file or permission error - skip
			skippedCount++;
			continue;
		}

		// Extract constraints
		const constraints = extractConstraintsFromContent(fullContent);

		if (constraints.length === 0) {
			skippedCount++;
			continue;
		}

		const docDetails: { path: string; score: number; constraints: string[] } = {
			path: docFile.path,
			score,
			constraints: [],
		};

		// Process each constraint with dedup
		for (const constraint of constraints) {
			const duplicate = findNearDuplicate(
				constraint,
				existingEntries,
				DEDUP_THRESHOLD,
			);
			if (!duplicate) {
				const entry: SwarmKnowledgeEntry = {
					id: crypto.randomUUID(),
					tier: 'swarm',
					lesson: constraint,
					category: 'architecture',
					tags: ['doc-scan', path.basename(docFile.path)],
					scope: 'global',
					confidence: 0.5,
					status: 'candidate',
					confirmed_by: [],
					project_name: '',
					retrieval_outcomes: {
						applied_count: 0,
						succeeded_after_count: 0,
						failed_after_count: 0,
					},
					schema_version: 1,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					auto_generated: true,
					hive_eligible: false,
				};
				await appendKnowledge(knowledgePath, entry);
				existingEntries.push(entry);
				extractedCount++;
				docDetails.constraints.push(constraint);
			}
		}

		if (docDetails.constraints.length > 0) {
			details.push(docDetails);
		} else {
			// All constraints were duplicates
			skippedCount++;
		}
	}

	return { extracted: extractedCount, skipped: skippedCount, details };
}

// ============ Tool Definitions ============

export const doc_scan: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Scan project documentation files and build an index manifest. Caches results in .swarm/doc-manifest.json for fast subsequent scans.',
	args: {
		force: z
			.boolean()
			.optional()
			.describe('Force re-scan even if cache is valid'),
	},
	execute: async (args: unknown, directory: string): Promise<string> => {
		// Parse args safely
		let force = false;
		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				if (obj.force === true) force = true;
			}
		} catch {
			// Malicious getter threw
		}

		// If force, delete existing manifest to invalidate cache
		if (force) {
			const manifestPath = path.join(directory, '.swarm', 'doc-manifest.json');
			try {
				fs.unlinkSync(manifestPath);
			} catch {
				// File may not exist
			}
		}

		const { manifest, cached } = await scanDocIndex(directory);

		return JSON.stringify(
			{
				success: true,
				files_count: manifest.files.length,
				cached,
				manifest,
			},
			null,
			2,
		);
	},
});

export const doc_extract: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Extract actionable constraints from project documentation relevant to the current task. Scans docs via doc-manifest, scores relevance via Jaccard bigram similarity, and stores non-duplicate constraints in .swarm/knowledge.jsonl.',
	args: {
		task_files: z
			.array(z.string())
			.describe('List of file paths involved in the current task'),
		task_description: z.string().describe('Description of the current task'),
	},
	execute: async (args: unknown, directory: string): Promise<string> => {
		// Safe args extraction
		let taskFiles: string[] = [];
		let taskDescription = '';
		try {
			if (args && typeof args === 'object') {
				const obj = args as Record<string, unknown>;
				if (Array.isArray(obj.task_files)) {
					taskFiles = obj.task_files.filter(
						(f): f is string => typeof f === 'string',
					);
				}
				if (typeof obj.task_description === 'string') {
					taskDescription = obj.task_description;
				}
			}
		} catch {
			// Malicious getter threw
		}

		if (taskFiles.length === 0 && !taskDescription) {
			return JSON.stringify({
				success: false,
				error: 'task_files or task_description is required',
			});
		}

		const result = await extractDocConstraints(
			directory,
			taskFiles,
			taskDescription,
		);
		return JSON.stringify({ success: true, ...result }, null, 2);
	},
});
