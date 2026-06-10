import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { PluginConfig } from '../config';
import type { EvidenceVerdict } from '../config/evidence-schema';
import { saveEvidence } from '../evidence/manager';
import { getProfileForFile } from '../lang/detector';
import { getLanguageForExtension, getParserForFile } from '../lang/registry';
import type { Parser } from '../lang/runtime';
import { createSwarmTool } from './create-tool';

export interface SyntaxCheckInput {
	/** Files to check (from diff gate) */
	changed_files: Array<{ path: string; additions: number }>;
	/** Check mode: 'changed' = only changed files, 'all' = all files in repo */
	mode?: 'changed' | 'all';
	/** Optional: restrict to specific languages */
	languages?: string[];
}

export interface SyntaxCheckFileResult {
	path: string;
	language: string;
	ok: boolean;
	errors: Array<{
		line: number;
		column: number;
		message: string;
	}>;
	skipped_reason?: string;
}

export interface SyntaxCheckResult {
	verdict: EvidenceVerdict;
	files: SyntaxCheckFileResult[];
	summary: string;
}

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — WASM tree-sitter aborts on larger files
const BINARY_CHECK_BYTES = 8192; // 8KB
const BINARY_NULL_THRESHOLD = 0.1; // 10% null bytes
// Bounded concurrency for per-file processing. Each file does a sync read +
// sync parse; the cap keeps file-descriptor and memory pressure predictable
// for large diffs while overlapping the async grammar-load awaits.
const SYNTAX_CHECK_CONCURRENCY = 8;

/**
 * Check if file content appears to be binary
 * Looks for high percentage of null bytes in first 8KB
 */
function isBinaryContent(content: string): boolean {
	const sample = content.slice(0, BINARY_CHECK_BYTES);
	let nullCount = 0;
	for (let i = 0; i < sample.length; i++) {
		if (sample.charCodeAt(i) === 0) {
			nullCount++;
		}
	}
	return nullCount / sample.length > BINARY_NULL_THRESHOLD;
}

/**
 * Extract syntax errors from parse tree
 * Returns empty array if parse succeeds with no errors
 */
function extractSyntaxErrors(
	parser: Parser,
	content: string,
): Array<{ line: number; column: number; message: string }> {
	const tree = parser.parse(content);
	if (!tree) {
		return [];
	}

	const errors: Array<{ line: number; column: number; message: string }> = [];

	// Walk the tree to find ERROR and MISSING nodes using an explicit stack
	// rather than recursion. A deeply nested parse tree (heavily nested JSON,
	// minified code) could otherwise overflow the JS call stack (DD-C018);
	// the explicit stack moves the traversal onto the heap. Children are
	// pushed in reverse so they are visited left-to-right (pre-order),
	// matching the previous recursive order.
	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
	const stack: any[] = [tree.rootNode];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node.type === 'ERROR') {
			errors.push({
				line: node.startPosition.row + 1, // 1-indexed
				column: node.startPosition.column,
				message: 'Syntax error',
			});
		} else if (node.isMissing) {
			errors.push({
				line: node.startPosition.row + 1,
				column: node.startPosition.column,
				message: `Missing '${node.type}'`,
			});
		}
		const children = node.children;
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push(children[i]);
		}
	}

	// Fallback: if tree-walking found no explicit ERROR/MISSING nodes but the
	// root reports hasError, flag the file so errors aren't silently swallowed
	// (can happen when WASM tree-sitter is partially degraded in test environments)
	if (errors.length === 0 && tree.rootNode.hasError) {
		errors.push({
			line: 1,
			column: 0,
			message: 'Syntax error detected (tree has errors)',
		});
	}

	tree.delete();

	return errors;
}

/**
 * Run syntax check on changed files
 *
 * Respects config.gates.syntax_check.enabled - returns skipped if disabled
 */
export async function syntaxCheck(
	input: SyntaxCheckInput,
	directory: string,
	config?: PluginConfig,
): Promise<SyntaxCheckResult> {
	// Check feature flag
	if (config?.gates?.syntax_check?.enabled === false) {
		return {
			verdict: 'pass', // 'pass' to not block, but log skipped
			files: [],
			summary: 'syntax_check disabled by configuration',
		};
	}

	const { changed_files, mode = 'changed', languages } = input;

	// Filter files
	let filesToCheck = changed_files;

	// In 'changed' mode, filter to additions > 0
	if (mode === 'changed') {
		filesToCheck = filesToCheck.filter((f) => f.additions > 0);
	}

	// Optional: filter by language
	if (languages?.length) {
		const lowerLangs = languages.map((l) => l.toLowerCase());
		filesToCheck = filesToCheck.filter((file) => {
			const ext = path.extname(file.path).toLowerCase();
			const langDef = getLanguageForExtension(ext);
			const fileProfile = getProfileForFile(file.path);
			const langId = fileProfile?.id || langDef?.id;
			return langId ? lowerLangs.includes(langId.toLowerCase()) : false;
		});
	}

	// Hoist the runtime module import out of the per-file loop (DD-C020). ESM
	// caches the module, but loading it once before the fan-out keeps the hot
	// path free of a redundant dynamic-import expression per file.
	const { loadGrammar } = await import('../lang/runtime');

	/**
	 * Per-file processing outcome. `counted`/`failed`/`skipped` reproduce the
	 * exact counter semantics of the original sequential loop so the summary
	 * numbers are unchanged: early skips (unsupported/read-error/too-large/
	 * binary) are counted as skipped only; parse outcomes are counted; a thrown
	 * error during processing counts as both skipped and checked.
	 */
	interface FileOutcome {
		result: SyntaxCheckFileResult;
		counted: boolean;
		failed: boolean;
		skipped: boolean;
	}

	async function checkOneFile(fileInfo: {
		path: string;
		additions: number;
	}): Promise<FileOutcome> {
		const { path: filePath } = fileInfo;
		const fullPath = path.isAbsolute(filePath)
			? filePath
			: path.join(directory, filePath);

		const result: SyntaxCheckFileResult = {
			path: filePath,
			language: '',
			ok: false,
			errors: [],
		};

		try {
			// Try profile-driven grammar resolution first (supports Tier 1–3 languages)
			const profile = getProfileForFile(filePath);
			const grammarId = profile?.treeSitter?.grammarId;
			let parser: Parser | null = null;
			if (grammarId) {
				try {
					parser = await loadGrammar(grammarId);
				} catch {
					parser = null;
				}
			}
			// Fallback: use existing registry-based resolution for languages not in profiles
			if (!parser) {
				parser = await getParserForFile(filePath);
			}
			if (!parser) {
				result.skipped_reason = 'unsupported_language';
				return { result, counted: false, failed: false, skipped: true };
			}

			// Size pre-check via stat to avoid reading large files into memory
			// just to reject them (DD-C017). stat is a best-effort optimization:
			// if it is unavailable or throws, fall through to the read, whose own
			// error handling and the post-read size guard still apply.
			try {
				const stat = fs.statSync(fullPath);
				if (stat.size >= MAX_FILE_SIZE) {
					result.skipped_reason = 'file_too_large';
					return { result, counted: false, failed: false, skipped: true };
				}
			} catch {
				// stat unavailable/failed — proceed to read below
			}

			// Read file content
			let content: string;
			try {
				content = fs.readFileSync(fullPath, 'utf8');
			} catch {
				result.skipped_reason = 'file_read_error';
				return { result, counted: false, failed: false, skipped: true };
			}

			// Check file size (defensive: character length, post-read)
			if (content.length >= MAX_FILE_SIZE) {
				result.skipped_reason = 'file_too_large';
				return { result, counted: false, failed: false, skipped: true };
			}

			// Check for binary content
			if (isBinaryContent(content)) {
				result.skipped_reason = 'binary_file';
				return { result, counted: false, failed: false, skipped: true };
			}

			// Resolve language ID: prefer profile, fall back to registry
			const ext = path.extname(filePath).toLowerCase();
			const langDef = getLanguageForExtension(ext);
			result.language = profile?.id || langDef?.id || 'unknown';

			// Parse and extract errors
			const errors = extractSyntaxErrors(parser, content);

			if (errors.length > 0) {
				result.ok = false;
				result.errors = errors;
				return { result, counted: true, failed: true, skipped: false };
			}
			result.ok = true;
			return { result, counted: true, failed: false, skipped: false };
		} catch (error) {
			result.skipped_reason =
				error instanceof Error ? error.message : 'unknown_error';
			return { result, counted: true, failed: false, skipped: true };
		}
	}

	// Process files with bounded concurrency (DD-C019). Order is preserved by
	// mapping over the input array; counters are aggregated deterministically
	// from the resolved outcomes afterward.
	const limit = pLimit(SYNTAX_CHECK_CONCURRENCY);
	const outcomes = await Promise.all(
		filesToCheck.map((fileInfo) => limit(() => checkOneFile(fileInfo))),
	);

	const results: SyntaxCheckFileResult[] = [];
	let filesChecked = 0;
	let filesFailed = 0;
	let skippedCount = 0;
	for (const outcome of outcomes) {
		results.push(outcome.result);
		if (outcome.counted) filesChecked++;
		if (outcome.failed) filesFailed++;
		if (outcome.skipped) skippedCount++;
	}

	const verdict: EvidenceVerdict = filesFailed > 0 ? 'fail' : 'pass';

	const summary =
		filesFailed > 0
			? `Syntax errors found in ${filesFailed} of ${filesChecked} files`
			: `All ${filesChecked} files passed syntax check`;

	// Save evidence
	await saveEvidence(directory, 'syntax_check', {
		task_id: 'syntax_check',
		type: 'syntax',
		timestamp: new Date().toISOString(),
		agent: 'syntax_check',
		verdict,
		summary,
		files_checked: filesChecked,
		files_failed: filesFailed,
		skipped_count: skippedCount,
		files: results,
	});

	return {
		verdict,
		files: results,
		summary,
	};
}

export const syntax_check: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Check syntax of source files using tree-sitter parsers. Supports JS/TS, Python, Go, Rust, Java, C/C++, C#, PHP, Ruby. Returns JSON with syntax errors found per file.',
	args: {
		changed_files: z
			.array(
				z.object({
					path: z.string(),
					additions: z.number(),
				}),
			)
			.describe('Files to check (from diff gate)'),
		mode: z
			.enum(['changed', 'all'])
			.optional()
			.describe(
				"Check mode: 'changed' = only changed files, 'all' = all files in repo",
			),
		languages: z
			.array(z.string())
			.optional()
			.describe('Optional: restrict to specific languages'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		const result = await syntaxCheck(
			args as {
				changed_files: Array<{ path: string; additions: number }>;
				mode?: 'changed' | 'all';
				languages?: string[];
			},
			directory,
		);
		return JSON.stringify(result);
	},
});
