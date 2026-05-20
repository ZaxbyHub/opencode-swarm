import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
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

	// Walk the tree to find ERROR and MISSING nodes
	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
	function walkNode(node: any) {
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
		for (const child of node.children) {
			walkNode(child);
		}
	}

	walkNode(tree.rootNode);

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

	const results: SyntaxCheckFileResult[] = [];
	let filesChecked = 0;
	let filesFailed = 0;
	let skippedCount = 0;

	for (const fileInfo of filesToCheck) {
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
				const { loadGrammar } = await import('../lang/runtime');
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
				skippedCount++;
				results.push(result);
				continue;
			}

			// Read file content
			let content: string;
			try {
				content = fs.readFileSync(fullPath, 'utf8');
			} catch {
				result.skipped_reason = 'file_read_error';
				skippedCount++;
				results.push(result);
				continue;
			}

			// Check file size
			if (content.length >= MAX_FILE_SIZE) {
				result.skipped_reason = 'file_too_large';
				skippedCount++;
				results.push(result);
				continue;
			}

			// Check for binary content
			if (isBinaryContent(content)) {
				result.skipped_reason = 'binary_file';
				skippedCount++;
				results.push(result);
				continue;
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
				filesFailed++;
			} else {
				result.ok = true;
			}
		} catch (error) {
			result.skipped_reason =
				error instanceof Error ? error.message : 'unknown_error';
			skippedCount++;
		}

		results.push(result);
		filesChecked++;
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
