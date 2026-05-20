import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { EvidenceVerdict } from '../config/evidence-schema';
import { saveEvidence } from '../evidence/manager';
import { getParserForFile } from '../lang/registry';
import { escapeRegex } from '../utils';
import { createSwarmTool } from './create-tool';

// ============ Types ============

export interface PlaceholderScanInput {
	changed_files: string[];
	allow_globs?: string[];
	deny_patterns?: string[];
}

export interface PlaceholderFinding {
	path: string;
	line: number;
	kind: 'comment' | 'string' | 'function_body' | 'other';
	excerpt: string;
	rule_id: string;
}

export interface PlaceholderScanResult {
	verdict: EvidenceVerdict;
	findings: PlaceholderFinding[];
	summary: {
		files_scanned: number;
		findings_count: number;
		files_with_findings: number;
	};
}

// ============ Constants ============

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// Default deny patterns (comment patterns)
const DEFAULT_COMMENT_PATTERNS = [
	{ pattern: /\bTODO\b/i, rule_id: 'placeholder/comment-todo' },
	{ pattern: /\bFIXME\b/i, rule_id: 'placeholder/comment-fixme' },
	{ pattern: /\bTBD\b/i, rule_id: 'placeholder/comment-other' },
	{ pattern: /\bXXX\b/i, rule_id: 'placeholder/comment-other' },
	{ pattern: /\bHACK\b/i, rule_id: 'placeholder/comment-other' },
];

// Default deny patterns (text in strings)
const DEFAULT_STRING_PATTERNS = [
	{
		pattern: /"[^"]*\bplaceholder\b[^"]*"/i,
		rule_id: 'placeholder/text-placeholder',
	},
	{ pattern: /"[^"]*\bstub\b[^"]*"/i, rule_id: 'placeholder/text-placeholder' },
	{ pattern: /"[^"]*\bwip\b[^"]*"/i, rule_id: 'placeholder/text-placeholder' },
	{
		pattern: /"[^"]*\bnot implemented\b[^"]*"/i,
		rule_id: 'placeholder/text-placeholder',
	},
	{
		pattern: /'[^']*\bplaceholder\b[^']*'/i,
		rule_id: 'placeholder/text-placeholder',
	},
	{ pattern: /'[^']*\bstub\b[^']*'/i, rule_id: 'placeholder/text-placeholder' },
	{ pattern: /'[^']*\bwip\b[^']*'/i, rule_id: 'placeholder/text-placeholder' },
	{
		pattern: /`[^`]*\bplaceholder\b[^`]*`/i,
		rule_id: 'placeholder/text-placeholder',
	},
	{ pattern: /`[^`]*\bstub\b[^`]*`/i, rule_id: 'placeholder/text-placeholder' },
];

// Files that are allowlisted from ALL placeholder scanning
// These files contain legitimate patterns that would otherwise trigger false positives
const FILE_ALLOWLIST = [
	'src/tools/declare-scope.ts', // validateTaskIdFormat returns undefined as success indicator
	'src/tools/placeholder-scan.ts', // self-referential rule definitions would always match
];

// Default deny patterns (code stubs)
const DEFAULT_CODE_PATTERNS = [
	{
		pattern: /throw\s+new\s+Error\s*\(\s*["'][^"']*\bTODO\b[^"']*["']\s*\)/i,
		rule_id: 'placeholder/code-throw-todo',
	},
	{
		pattern: /throw\s+new\s+Error\s*\(\s*["'][^"']*\bFIXME\b[^"']*["']\s*\)/i,
		rule_id: 'placeholder/code-throw-todo',
	},
	{ pattern: /return\s+null\s*;/, rule_id: 'placeholder/code-stub-return' },
	{
		pattern: /return\s+undefined\s*;/,
		rule_id: 'placeholder/code-stub-return',
	},
	{ pattern: /return\s+None\s*$/m, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+0\s*;/, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+false\s*;/i, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+true\s*;/i, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+""\s*;/, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+\[\]\s*;/, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+\{\}\s*;/, rule_id: 'placeholder/code-stub-return' },
	{ pattern: /return\s+nil\s*;/, rule_id: 'placeholder/code-stub-return' },
];

// Plan file bracket-placeholder patterns (detect template placeholders in .swarm/plan.md)
const PLAN_PLACEHOLDER_PATTERNS = [
	{ pattern: /\[task\]/gi, rule_id: 'placeholder/plan-bracket-task' },
	{ pattern: /\[Project\]/g, rule_id: 'placeholder/plan-bracket-project' },
	{ pattern: /\[date\]/g, rule_id: 'placeholder/plan-bracket-date' },
	{ pattern: /\[reason\]/g, rule_id: 'placeholder/plan-bracket-reason' },
	{
		pattern: /\[description\]/gi,
		rule_id: 'placeholder/plan-bracket-description',
	},
];

// Test file patterns (to skip) - based on path patterns
// Note: patterns check for the directory in the path
const TEST_PATH_PATTERNS = [
	/\.test\./, // matches: something.test.ts
	/\.spec\./, // matches: something.spec.ts
	/\btests?\//, // matches: tests/, test/ directory
	/\b__tests?__\//, // matches: __tests__/, __test__/ directory
	/\bmocks?\//, // matches: mocks/, mock/ directory
	/\b__mocks?__\//, // matches: __mocks__/, __mock__/ directory
	/\bspecs?\//, // matches: specs/, spec/ directory
	/\b__specs?__\//, // matches: __specs__/, __spec__/ directory
];

// Generated/scaffold file patterns - these files WILL be scanned for placeholders
const SCAFFOLD_PATH_PATTERNS = [
	/\bgenerated\//, // matches: generated/ directory
	/\bscaffold\//, // matches: scaffold/ directory
	/\btemplates?\//, // matches: templates/, template/ directory
	/\b__generated__\//, // matches: __generated__/ directory
	/\b__scaffold__\//, // matches: __scaffold__/ directory
];

// Filename patterns for generated/scaffold files
const SCAFFOLD_FILENAME_PATTERNS = [
	/^gen-/, // matches: gen-something.ts
	/^scaffold-/, // matches: scaffold-something.ts
	/^template-/, // matches: template-something.ts
	/\.gen\./, // matches: something.gen.ts
	/\.scaffold\./, // matches: something.scaffold.ts
	/\.template\./, // matches: something.template.ts
];

// Supported extensions for Tree-sitter parsing
const SUPPORTED_PARSER_EXTENSIONS = new Set([
	'.js',
	'.jsx',
	'.ts',
	'.tsx',
	'.py',
	'.go',
	'.rs',
	'.java',
	'.c',
	'.cpp',
	'.h',
	'.hpp',
	'.cs',
	'.php',
	'.blade.php',
	'.rb',
]);

// ============ Helper Functions ============

/**
 * Check if a file is a test file based on path patterns
 */
function isTestFile(filePath: string): boolean {
	const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
	return TEST_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

/**
 * Check if a file is a generated/scaffold file based on path or filename patterns
 * Generated scaffold files WILL be scanned for placeholders (unlike test files which are skipped)
 */
function isScaffoldFile(filePath: string): boolean {
	const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');

	// Check path patterns (directory-based)
	if (SCAFFOLD_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
		return true;
	}

	// Check filename patterns
	const filename = path.basename(filePath);
	if (SCAFFOLD_FILENAME_PATTERNS.some((pattern) => pattern.test(filename))) {
		return true;
	}

	return false;
}

/**
 * Check if file should be allowed based on allow_globs
 */
function isAllowedByGlobs(filePath: string, allowGlobs?: string[]): boolean {
	if (!allowGlobs || allowGlobs.length === 0) {
		return false;
	}

	const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');

	for (const glob of allowGlobs) {
		// Convert glob to regex
		// ** → match any characters including /
		// * → match any characters except /
		// (Note: in globs, . is literal, not regex special)
		const regexPattern = glob
			.replace(/\*\*/g, '<<<DBL>>>') // Save ** first
			.replace(/\*/g, '([^/]+)') // * → match non-slash chars
			.replace(/<<<DBL>>>/g, '(.*)'); // ** → match any chars including slash

		// Test if path starts with the glob pattern
		const regex = new RegExp(`^${regexPattern}`, 'i');
		if (regex.test(normalizedPath)) {
			return true;
		}

		// Also try matching just the filename
		const filename = path.basename(filePath);
		const filenameRegex = new RegExp(`^${regexPattern}$`, 'i');
		if (filenameRegex.test(filename)) {
			return true;
		}
	}

	return false;
}

/**
 * Check if file uses a supported parser language
 */
function isParserSupported(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return SUPPORTED_PARSER_EXTENSIONS.has(ext);
}

/**
 * Check if a file is a plan file (.swarm/plan.md) that should be scanned
 * for bracket-placeholder patterns
 */
function isPlanFile(filePath: string): boolean {
	const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
	return (
		normalizedPath.endsWith('.swarm/plan.md') ||
		normalizedPath.includes('/.swarm/plan.md')
	);
}

/**
 * Scan a plan file (.swarm/plan.md) for bracket-placeholder patterns
 * that indicate the architect reproduced the template literally
 */
function scanPlanFileForPlaceholders(
	content: string,
	filePath: string,
): PlaceholderFinding[] {
	const findings: PlaceholderFinding[] = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;

		for (const { pattern, rule_id } of PLAN_PLACEHOLDER_PATTERNS) {
			if (pattern.test(line)) {
				findings.push({
					path: filePath,
					line: lineNumber,
					kind: 'other',
					excerpt: line.substring(0, 100),
					rule_id,
				});
			}
			// Reset regex lastIndex for global patterns
			pattern.lastIndex = 0;
		}
	}

	return findings;
}

/**
 * Check if a `return undefined;` is a validation pattern (not a stub).
 * Returns true if the function has:
 * - JSDoc `@returns` that documents undefined as valid
 * - Error string returns in the same function (validation pattern)
 */
function isValidationPattern(lines: string[], currentLineIdx: number): boolean {
	// Only applies to `return undefined;`
	const currentLine = lines[currentLineIdx];
	if (!/return\s+undefined\s*;/.test(currentLine)) {
		return false;
	}

	// Search backwards for function declaration and JSDoc (limit search to 50 lines)
	const MAX_SEARCH_LINES = 50;
	let jsdocContent = '';
	let _foundFunction = false;
	const functionKeywords =
		/^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:async\s+)?(?:\w+\s+)?\w+\s*\([^)]*\)\s*(?::\s*\w+\s*)?(?:\{|$)/;

	for (
		let i = currentLineIdx - 1;
		i >= 0 && i >= currentLineIdx - MAX_SEARCH_LINES;
		i--
	) {
		const line = lines[i].trim();

		// Look for JSDoc comment content
		if (line.startsWith('*') || line.startsWith('*/')) {
			// Collect JSDoc lines
			const jsdocLine = line.replace(/^\*?\s?/, '').replace(/^\*\//, '');
			jsdocContent = `${jsdocLine}\n${jsdocContent}`;
		} else if (line.includes('*/')) {
			// End of JSDoc block
			break;
		} else if (functionKeywords.test(line) || line.startsWith('function ')) {
			_foundFunction = true;
			break;
		} else if (
			line.length > 0 &&
			!line.startsWith('//') &&
			!line.startsWith('*')
		) {
			// Non-empty, non-comment line that's not JSDoc or function - stop searching
			break;
		}
	}

	// Check JSDoc for `@returns undefined` or `@returns {undefined}`
	if (jsdocContent) {
		const returnsPattern =
			/@returns\s*(?:\{[^}]*\})?\s*(?:undefined|[A-Za-z_]\w*)/i;
		if (returnsPattern.test(jsdocContent)) {
			return true;
		}
	}

	// Search forward in the same function for error returns
	// (we already know this is `return undefined;`, now check if there's also error returns)
	let braceCount = 0;
	let inFunction = false;

	// Count braces from function start to `return undefined;`
	for (let i = currentLineIdx; i >= 0; i--) {
		const line = lines[i];
		for (const char of line) {
			if (char === '{') {
				braceCount++;
				inFunction = true;
			} else if (char === '}') {
				braceCount--;
			}
		}
		if (inFunction && braceCount === 0 && i < currentLineIdx) {
			break;
		}
	}

	// Check if this `return undefined;` coexists with error string returns
	// Look for patterns like: return "error", return `error`, return 'error'
	const errorReturnPattern = /return\s+["'`][[:ascii:]]*["'`]\s*;/;
	for (
		let i = currentLineIdx - 1;
		i >= 0 && i >= currentLineIdx - MAX_SEARCH_LINES;
		i--
	) {
		const line = lines[i].trim();
		if (functionKeywords.test(line) || line.startsWith('function ')) {
			break;
		}
		if (errorReturnPattern.test(line)) {
			return true;
		}
	}

	return false;
}

/**
 * Regex-based scanner for comments and strings
 * Works for any language using comment markers
 */
function scanWithRegex(
	content: string,
	filePath: string,
	denyPatterns: {
		comment: typeof DEFAULT_COMMENT_PATTERNS;
		string: typeof DEFAULT_STRING_PATTERNS;
		code: typeof DEFAULT_CODE_PATTERNS;
	},
): PlaceholderFinding[] {
	const findings: PlaceholderFinding[] = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;

		// Check comment patterns (various comment styles)
		// // comment, # comment, /* comment */, <!-- comment -->
		const lineCommentMatch = line.match(/(?:\/\/|#|<!--)\s*(.*)$/);
		if (lineCommentMatch) {
			const commentText = lineCommentMatch[1];
			for (const { pattern, rule_id } of denyPatterns.comment) {
				if (pattern.test(commentText)) {
					findings.push({
						path: filePath,
						line: lineNumber,
						kind: 'comment',
						excerpt: line.substring(0, 100),
						rule_id,
					});
					break; // Only report one finding per line for comments
				}
			}
		}

		// Check block comments (/* ... */) - need multi-line handling
		const blockCommentMatch = line.match(/\/\*([\s\S]*?)\*\//);
		if (blockCommentMatch) {
			const commentText = blockCommentMatch[1];
			for (const { pattern, rule_id } of denyPatterns.comment) {
				if (pattern.test(commentText)) {
					findings.push({
						path: filePath,
						line: lineNumber,
						kind: 'comment',
						excerpt: line.substring(0, 100),
						rule_id,
					});
					break;
				}
			}
		}

		// Check string patterns (double, single, template literals)
		const stringMatches = line.match(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g);
		if (stringMatches) {
			for (const stringContent of stringMatches) {
				for (const { pattern, rule_id } of denyPatterns.string) {
					if (pattern.test(stringContent)) {
						findings.push({
							path: filePath,
							line: lineNumber,
							kind: 'string',
							excerpt: line.substring(0, 100),
							rule_id,
						});
						break;
					}
				}
			}
		}

		// Check code patterns (stub returns, throw TODO)
		for (const { pattern, rule_id } of denyPatterns.code) {
			// Skip if this line looks like a test
			const isTestLike =
				line.includes('describe(') ||
				line.includes('it(') ||
				line.includes('test(') ||
				line.includes('expect(');

			if (!isTestLike && pattern.test(line)) {
				// For `code-stub-return` with `return undefined;`, check if it's a validation pattern
				if (
					rule_id === 'placeholder/code-stub-return' &&
					/return\s+undefined\s*;/.test(line)
				) {
					if (isValidationPattern(lines, i)) {
						continue;
					}
				}

				findings.push({
					path: filePath,
					line: lineNumber,
					kind: 'function_body',
					excerpt: line.substring(0, 100),
					rule_id,
				});
			}
		}
	}

	return findings;
}

/**
 * Tree-sitter-based scanner for supported languages
 * Adds parser-based findings to regex findings
 */
async function scanWithParser(
	content: string,
	filePath: string,
	denyPatterns: {
		comment: typeof DEFAULT_COMMENT_PATTERNS;
		string: typeof DEFAULT_STRING_PATTERNS;
		code: typeof DEFAULT_CODE_PATTERNS;
	},
): Promise<PlaceholderFinding[]> {
	const findings: PlaceholderFinding[] = [];

	// First do regex scan (works reliably)
	const regexFindings = scanWithRegex(content, filePath, denyPatterns);
	findings.push(...regexFindings);

	// Then try parser for additional coverage
	const parser = await getParserForFile(filePath);
	if (!parser) {
		return findings;
	}

	try {
		const tree = parser.parse(content);
		if (!tree || !tree.rootNode) {
			return findings;
		}

		// Walk the tree to find comment and string nodes
		// Using a set to avoid duplicates with regex findings
		const seenKeys = new Set<string>();
		for (const f of findings) {
			seenKeys.add(`${f.line}:${f.rule_id}`);
		}

		// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
		function walkNode(node: any) {
			const nodeType = node.type;
			const nodeText = node.text;
			const lineNum = node.startPosition.row + 1;

			// Check comment nodes (various types across languages)
			if (
				nodeType === 'comment' ||
				nodeType === 'line_comment' ||
				nodeType === 'block_comment' ||
				nodeType === 'documentation_comment' ||
				nodeType === 'doc_comment'
			) {
				for (const { pattern, rule_id } of denyPatterns.comment) {
					const key = `${lineNum}:${rule_id}`;
					if (!seenKeys.has(key) && pattern.test(nodeText)) {
						seenKeys.add(key);
						findings.push({
							path: filePath,
							line: lineNum,
							kind: 'comment',
							excerpt: nodeText.substring(0, 100),
							rule_id,
						});
					}
				}
			}

			// Check string literals
			if (
				nodeType === 'string' ||
				nodeType === 'template_string' ||
				nodeType === 'string_literal' ||
				nodeType === 'string_fragment'
			) {
				for (const { pattern, rule_id } of denyPatterns.string) {
					const key = `${lineNum}:${rule_id}`;
					if (!seenKeys.has(key) && pattern.test(nodeText)) {
						seenKeys.add(key);
						findings.push({
							path: filePath,
							line: lineNum,
							kind: 'string',
							excerpt: nodeText.substring(0, 100),
							rule_id,
						});
					}
				}
			}

			// Recursively walk children
			if (node.children) {
				for (const child of node.children) {
					walkNode(child);
				}
			}
		}

		walkNode(tree.rootNode);
		tree.delete();
	} catch {
		// Parser error - we already have regex findings
	}

	return findings;
}

// ============ Main Function ============

/**
 * Scan files for placeholder content (TODO/FIXME comments, stub implementations, etc.)
 */
export async function placeholderScan(
	input: PlaceholderScanInput,
	directory: string,
): Promise<PlaceholderScanResult> {
	const { changed_files, allow_globs, deny_patterns } = input;

	// Build deny patterns
	// If custom patterns are provided, they replace the defaults
	let commentPatterns = DEFAULT_COMMENT_PATTERNS;
	let stringPatterns = DEFAULT_STRING_PATTERNS;
	let codePatterns = DEFAULT_CODE_PATTERNS;

	if (deny_patterns && deny_patterns.length > 0) {
		// Parse custom patterns - they can be simple strings like "TODO" or regex-like
		commentPatterns = deny_patterns.map((p) => ({
			pattern: new RegExp(`\\b${escapeRegex(p)}\\b`, 'i'),
			rule_id: `placeholder/custom-${p.toLowerCase()}`,
		}));
		// With custom patterns, disable string and code patterns
		stringPatterns = [];
		codePatterns = [];
	}

	const denyPatterns = {
		comment: commentPatterns,
		string: stringPatterns,
		code: codePatterns,
	};

	const findings: PlaceholderFinding[] = [];
	let filesScanned = 0;
	const filesWithFindings = new Set<string>();

	for (const filePath of changed_files) {
		const fullPath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(directory, filePath);

		// Security: reject paths that escape the working directory via traversal
		const resolvedDirectory = path.resolve(directory);
		if (
			!fullPath.startsWith(resolvedDirectory + path.sep) &&
			fullPath !== resolvedDirectory
		) {
			continue;
		}

		// Skip if file doesn't exist
		if (!fs.existsSync(fullPath)) {
			continue;
		}

		// Check if allowed by globs (e.g., test files)
		if (isAllowedByGlobs(filePath, allow_globs)) {
			continue;
		}

		// Check if file is in the internal allowlist (skips all findings for this file)
		// Normalize to relative path for comparison with allowlist entries
		const relativeFilePath = path
			.relative(directory, fullPath)
			.replace(/\\/g, '/');
		if (FILE_ALLOWLIST.some((allowed) => relativeFilePath.endsWith(allowed))) {
			continue;
		}

		// Read content first to check for test patterns
		let content: string;
		try {
			const stat = fs.statSync(fullPath);
			if (stat.size > MAX_FILE_SIZE) {
				continue;
			}
			content = fs.readFileSync(fullPath, 'utf-8');
		} catch {
			continue;
		}

		// Skip binary files
		if (content.includes('\0')) {
			continue;
		}

		// Check if this is a scaffold/generated file - these ARE scanned for placeholders
		// (unlike test files which are skipped)
		const isScaffold = isScaffoldFile(filePath);

		// Skip test files by default (based on path patterns)
		// Note: scaffold files are NOT skipped - they are explicitly scanned for placeholders
		if (isTestFile(filePath) && !isScaffold) {
			continue;
		}

		filesScanned++;

		// Use plan-specific scanner for .swarm/plan.md, parser for supported languages, regex fallback otherwise
		let fileFindings: PlaceholderFinding[];
		if (isPlanFile(filePath)) {
			fileFindings = scanPlanFileForPlaceholders(content, filePath);
		} else if (isParserSupported(filePath)) {
			fileFindings = await scanWithParser(content, filePath, denyPatterns);
		} else {
			fileFindings = scanWithRegex(content, filePath, denyPatterns);
		}

		// Add findings to result
		if (fileFindings.length > 0) {
			findings.push(...fileFindings);
			filesWithFindings.add(filePath);
		}
	}

	const verdict: EvidenceVerdict = findings.length > 0 ? 'fail' : 'pass';

	// Save evidence
	await saveEvidence(directory, 'placeholder_scan', {
		task_id: 'placeholder_scan',
		type: 'placeholder',
		timestamp: new Date().toISOString(),
		agent: 'placeholder_scan',
		verdict,
		summary: `Scanned ${filesScanned} files, found ${findings.length} placeholder(s)`,
		files_scanned: filesScanned,
		findings_count: findings.length,
		files_with_findings: filesWithFindings.size,
		findings,
	});

	return {
		verdict,
		findings,
		summary: {
			files_scanned: filesScanned,
			findings_count: findings.length,
			files_with_findings: filesWithFindings.size,
		},
	};
}

export const placeholder_scan: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Scan source files for placeholder content (TODO/FIXME comments, stub implementations, unimplemented functions). Returns JSON with findings grouped by file and rule.',
	args: {
		changed_files: z
			.array(z.string())
			.describe('Files to scan for placeholders'),
		allow_globs: z
			.array(z.string())
			.optional()
			.describe('Globs to allow (skip scanning)'),
		deny_patterns: z
			.array(z.string())
			.optional()
			.describe('Custom deny patterns to search for'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		const result = await placeholderScan(
			args as {
				changed_files: string[];
				allow_globs?: string[];
				deny_patterns?: string[];
			},
			directory,
		);
		return JSON.stringify(result);
	},
});
