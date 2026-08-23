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
	/**
	 * When provided, the scanner filters findings to only report patterns
	 * on lines that were added in this PR. The direct API accepts Sets and the
	 * JSON tool boundary accepts arrays, which are normalized before scanning.
	 * Lines not in the set are treated as pre-existing and silently ignored.
	 */
	added_lines?: Record<string, Set<number> | number[]>;
	/**
	 * Values that suppress findings when found as substrings in the excerpt.
	 * Unlike FILE_ALLOWLIST (which skips entire files), this filters individual
	 * findings by matching against the excerpt text.
	 */
	sentinel_allowlist?: string[];
	/** @deprecated Use sentinel_allowlist. Kept for existing callers. */
	allow_sentinels?: string[];
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
const DEFAULT_SENTINEL_ALLOWLIST = ['SC-PLACEHOLDER'];

// Default deny patterns (comment patterns)
const DEFAULT_COMMENT_PATTERNS = [
	{ pattern: /\bTODO\b/i, rule_id: 'placeholder/comment-todo' },
	{ pattern: /\bFIXME\b/i, rule_id: 'placeholder/comment-fixme' },
	{ pattern: /\bTBD\b/i, rule_id: 'placeholder/comment-other' },
	// Case-sensitive: lowercase `xxx` is a common path-segment placeholder
	// in explanatory comments (e.g. `.claude/skills/xxx/SKILL.md`) and was
	// producing persistent false positives on scripts/drift-check.ts:1048.
	{ pattern: /\bXXX\b/, rule_id: 'placeholder/comment-other' },
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

// Languages the body-shape walker (collectNonStubBodyLines) has been verified
// against: TS/JS/TSX/Python. Other SUPPORTED_PARSER_EXTENSIONS languages (Go,
// Rust, Java, C/C++, C#, PHP, Ruby) share `function_declaration`/`block`-style
// node names with TS/JS but have different body-wrapping shapes (e.g. Go
// nests an extra `statement_list` inside `block`), so running the walker on
// them silently misclassifies every function as non-stub. They continue to
// use the regex-only pass for this rule until each is verified individually.
const BODY_SHAPE_SUPPORTED_EXTENSIONS = new Set([
	'.js',
	'.jsx',
	'.ts',
	'.tsx',
	'.py',
]);

function isBodyShapeSupported(filePath: string): boolean {
	return BODY_SHAPE_SUPPORTED_EXTENSIONS.has(
		path.extname(filePath).toLowerCase(),
	);
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
	addedLines?: Set<number>,
): PlaceholderFinding[] {
	const findings: PlaceholderFinding[] = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;
		if (addedLines && !addedLines.has(lineNumber)) continue;

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

/** Normalize JSON-array and direct-API Set inputs to the scanner's Set shape. */
function normalizeAddedLines(
	value: Set<number> | number[] | undefined,
): Set<number> | undefined {
	if (value instanceof Set) return value;
	if (Array.isArray(value)) return new Set(value);
	return undefined;
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
	addedLines?: Set<number>,
): PlaceholderFinding[] {
	const findings: PlaceholderFinding[] = [];
	const lines = content.split('\n');

	// When added_lines is provided, only report findings on PR-added lines
	const filterByAddedLines = addedLines !== undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;

		// Skip lines not in the added-lines set when diff-aware mode is active
		if (filterByAddedLines && !addedLines.has(lineNumber)) {
			continue;
		}

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
 * Adds parser-based findings to regex findings, then suppresses regex
 * `code-stub-return` false positives via function-body shape analysis.
 */
async function scanWithParser(
	content: string,
	filePath: string,
	denyPatterns: {
		comment: typeof DEFAULT_COMMENT_PATTERNS;
		string: typeof DEFAULT_STRING_PATTERNS;
		code: typeof DEFAULT_CODE_PATTERNS;
	},
	addedLines?: Set<number>,
): Promise<PlaceholderFinding[]> {
	const findings: PlaceholderFinding[] = [];

	// First do regex scan (works reliably)
	const regexFindings = scanWithRegex(
		content,
		filePath,
		denyPatterns,
		addedLines,
	);
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

		// When added_lines is provided, only report findings on PR-added lines
		const filterByAddedLines = addedLines !== undefined;

		// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
		function walkNode(node: any) {
			const nodeType = node.type;
			const nodeText = node.text;
			const lineNum = node.startPosition.row + 1;

			// Determine if this node is on an added line (for filtering findings)
			const isOnAddedLine = filterByAddedLines ? addedLines.has(lineNum) : true;

			// Check comment nodes (various types across languages)
			// Only report if the node is on an added line when diff-aware mode is active
			if (isOnAddedLine) {
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
			}

			// Always recurse into children — findings are filtered by isOnAddedLine above,
			// so skipping a parent node must not prevent traversal to its descendants
			if (node.children) {
				for (const child of node.children) {
					walkNode(child);
				}
			}
		}

		walkNode(tree.rootNode);

		// Body-shape analysis (TS/JS/Python only): suppress code-stub-return
		// findings on lines inside function bodies that are NOT pure stub
		// skeletons. The walker classifies each function body's effective
		// statement structure and returns the line ranges of bodies with
		// substantive subsequent behavior. For those lines, an existing
		// regex code-stub-return finding is a false positive (guard-clause
		// early return inside a non-stub function).
		//
		// Scope (this PR): TS/JS/Python only. Other parser-supported languages
		// (Go, Rust, Java, C/C++, C#, PHP, Ruby) are out of scope — they
		// continue to use the regex-only pass for this rule.
		//
		// Must live inside the try block so parse failure preserves regex
		// findings unchanged. Gated to the verified languages (see
		// isBodyShapeSupported) — do not widen this to all
		// SUPPORTED_PARSER_EXTENSIONS languages without verifying each one's
		// body-wrapping shape first.
		if (isBodyShapeSupported(filePath)) {
			try {
				const nonStubBodyLines = collectNonStubBodyLines(tree.rootNode);
				if (nonStubBodyLines.size > 0) {
					for (let i = findings.length - 1; i >= 0; i--) {
						const f = findings[i]!;
						if (
							f.rule_id === 'placeholder/code-stub-return' &&
							nonStubBodyLines.has(f.line)
						) {
							findings.splice(i, 1);
						}
					}
				}
			} catch {
				// Walker failed mid-loop — preserve remaining regex findings as-is.
			}
		}

		tree.delete();
	} catch {
		// Parser error - we already have regex findings
	}

	return findings;
}

/**
 * Classify a single expression node as a "constant literal" for stub-skeleton
 * detection. Returns true for nodes whose source text is one of:
 *   - `null`, `true`, `false` (JS/TS keywords; Python `none`/`True`/`False` differ)
 *   - `number` literals (e.g. `0`, `1`)
 *   - `string` literals (e.g. `""`)
 *   - `array` literals (e.g. `[]`)
 *   - `object` literals (e.g. `{}`)
 *   - `unary_expression` with operator `-` and number operand (e.g. `-1`)
 *   - `identifier` (a named constant reference, e.g. `CONFIG_DEFAULTS`)
 *   - `template_string` with NO `template_substitution` children
 *     (i.e. `\`hello\`` is constant; `\`hello ${world}\`` is not)
 *
 * Note: Python's `none`/`True`/`False`/`integer`/`float`/`string`/`list`/
 * `dictionary`/`tuple` map to tree-sitter-python grammar node types and
 * follow the same classification rules.
 */
// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
function isConstantLiteralNode(node: any): boolean {
	if (!node) return false;
	const t = node.type;

	// Direct constants
	if (
		t === 'null' ||
		t === 'true' ||
		t === 'false' ||
		t === 'number' ||
		t === 'string' ||
		t === 'array' ||
		t === 'object' ||
		t === 'identifier' ||
		// Python equivalents
		t === 'none' ||
		t === 'integer' ||
		t === 'float' ||
		t === 'list' ||
		t === 'dictionary' ||
		t === 'tuple'
	) {
		return true;
	}

	// Unary negative of a number (e.g. -1). The operator is the first child
	// node (its `text` is the operator character — `-`, `+`, `!`, `~`).
	if (
		t === 'unary_expression' &&
		Array.isArray(node.children) &&
		node.children.length >= 2 &&
		node.children[0]?.type === '-' &&
		node.children[1]?.type === 'number'
	) {
		return true;
	}

	// Template string with NO substitutions
	if (t === 'template_string') {
		// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
		const hasSubstitution: any =
			Array.isArray(node.children) &&
			node.children.some(
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
				(child: any) => child && child.type === 'template_substitution',
			);
		return !hasSubstitution;
	}

	return false;
}

/**
 * Determine whether a function's body (or expression body) is a "stub
 * skeleton" — exactly one effective statement, and that statement is a
 * constant return (or, for expression-bodied arrows, the body expression
 * itself is a constant).
 *
 * Returns true when the function IS a stub skeleton.
 * Returns false when the function has substantive subsequent behavior
 * (the constant return is a guard clause, not a stub).
 */
// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
function isStubSkeletonFunction(fnNode: any): boolean {
	if (!fnNode || typeof fnNode.type !== 'string') return false;

	const commentTypes = new Set([
		'comment',
		'line_comment',
		'block_comment',
		'documentation_comment',
		'doc_comment',
	]);
	const skipPunctuation = new Set(['{', '}', ':', ';', ',']);

	// Find the body among the function's children.
	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
	let bodyNode: any = null;
	const isArrow = fnNode.type === 'arrow_function';

	if (isArrow) {
		// Arrow: use the grammar's `body` field rather than a positional
		// skip-list. An arrow's possible leading children (`async`,
		// `type_parameters`, a bare `identifier` param, a `comment`, etc.)
		// kept growing every time a new arrow shape surfaced in review; the
		// field accessor is exact regardless of which optional tokens precede
		// the body. No availability guard: every arrow_function node from this
		// project's tree-sitter parser exposes childForFieldName — if that
		// ever stopped being true, throwing here (caught by scanWithParser's
		// walker try/catch, which preserves regex findings unchanged) is
		// safer than a `: null` fallback, which would silently disable
		// nested-stub protection instead of failing loudly.
		bodyNode = fnNode.childForFieldName('body');
	} else {
		// Block-bodied: look for `statement_block` (TS/JS) or `block`/`suite` (Python).
		if (Array.isArray(fnNode.children)) {
			for (const child of fnNode.children) {
				if (
					child &&
					(child.type === 'statement_block' ||
						child.type === 'block' ||
						child.type === 'suite')
				) {
					bodyNode = child;
					break;
				}
			}
		}
	}

	// Skip abstract/declared methods with no body.
	if (!bodyNode) return false;

	// Expression-bodied arrow: the body node IS the expression itself.
	// It's a stub iff that expression is a constant literal.
	if (isArrow && bodyNode.type !== 'statement_block') {
		return isConstantLiteralNode(bodyNode);
	}

	// Block-bodied forms: collect non-punctuation, non-comment direct children.
	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
	const effectiveStatements: any[] = [];
	if (Array.isArray(bodyNode.children)) {
		for (const child of bodyNode.children) {
			if (!child || typeof child.type !== 'string') continue;
			if (commentTypes.has(child.type)) continue;
			if (skipPunctuation.has(child.type)) continue;
			effectiveStatements.push(child);
		}
	}

	if (effectiveStatements.length !== 1) return false;

	const stmt = effectiveStatements[0];
	if (!stmt) return false;

	// Return statement with constant expression
	if (stmt.type === 'return_statement') {
		// Find the expression child (skip punctuation).
		// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
		const exprChild: any = Array.isArray(stmt.children)
			? stmt.children.find(
					// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
					(c: any) =>
						c &&
						typeof c.type === 'string' &&
						c.type !== 'return' &&
						c.type !== ';' &&
						!commentTypes.has(c.type),
				)
			: null;
		// Missing expression means `return;` — not a constant literal stub.
		if (!exprChild) return false;
		return isConstantLiteralNode(exprChild);
	}

	// Single non-return statement that is itself a constant literal
	// (defensive — should not normally occur).
	return isConstantLiteralNode(stmt);
}

/**
 * Walk a tree-sitter root node and collect the line numbers of all function
 * bodies whose structure is NOT a pure stub skeleton. These are the lines
 * where a regex `code-stub-return` finding should be suppressed, because
 * the function has substantive subsequent behavior and the constant return
 * is a guard clause.
 *
 * For expression-bodied arrows (where the body's range equals the arrow's
 * own range), we add only the lines that are INSIDE the body expression
 * itself, NOT the entire arrow's range — otherwise a curried arrow like
 * `const f = () => () => null;` would suppress the inner stub's finding
 * (because the outer arrow's range covers the inner arrow too).
 *
 * Recognized function-like node types:
 *   - TS/JS: `function_declaration`, `generator_function_declaration`,
 *     `method_definition`, `arrow_function`, `function_expression`,
 *     `generator_function`
 *   - Python: `function_definition`
 *
 * `method_definition` nodes with no body (abstract/declared methods) are
 * skipped. Getters and setters classify by their body like normal methods.
 */
// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
function collectNonStubBodyLines(rootNode: any): Set<number> {
	const result = new Set<number>();
	const stubSkeletonRanges: Array<[number, number]> = [];
	const functionNodeTypes = new Set([
		'function_declaration',
		'generator_function_declaration',
		'method_definition',
		'arrow_function',
		'function_definition',
		// Function expressions like `const cb = function() { return null; };`
		// and `const cb = function*() { ... };` — Kimi K3 final-critic F7.
		'function_expression',
		'generator_function',
	]);

	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
	function findBodyNode(fnNode: any): any {
		const isArrow = fnNode.type === 'arrow_function';
		if (isArrow) {
			// See isStubSkeletonFunction above: use the grammar's `body` field,
			// with no availability guard — see that function's comment for why.
			return fnNode.childForFieldName('body');
		}
		if (Array.isArray(fnNode.children)) {
			for (const child of fnNode.children) {
				if (
					child &&
					(child.type === 'statement_block' ||
						child.type === 'block' ||
						child.type === 'suite')
				) {
					return child;
				}
			}
		}
		return null;
	}

	// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node type not exported
	function walk(node: any) {
		if (!node || typeof node.type !== 'string') return;

		if (functionNodeTypes.has(node.type)) {
			const bodyNode = findBodyNode(node);
			const isStub = isStubSkeletonFunction(node);
			if (isStub && bodyNode) {
				// Track stub-skeleton ranges so non-stub ancestors don't
				// over-suppress the stub's `return <literal>;` line.
				const startLine = bodyNode.startPosition.row + 1;
				const endLine = bodyNode.endPosition.row + 1;
				stubSkeletonRanges.push([startLine, endLine]);
			} else if (!isStub && bodyNode) {
				// Non-stub function: add the BODY's range (not the function's
				// outer range) so we don't include the function signature /
				// closing brace. The body's range still may include nested
				// function declarations; we subtract stub-skeleton ranges
				// below so an inner stub isn't hidden.
				const startLine = bodyNode.startPosition.row + 1;
				const endLine = bodyNode.endPosition.row + 1;
				for (let line = startLine; line <= endLine; line++) {
					result.add(line);
				}
			}
		}

		// Always recurse into children so nested function-likes (e.g. inner
		// functions inside an outer non-stub function) get classified
		// independently.
		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}

	walk(rootNode);

	// Subtract stub-skeleton line ranges from the suppression set. This
	// handles the regression case: a non-stub outer function whose body
	// contains a nested stub function. The outer's body range covers the
	// inner's `return null;` line, but the inner IS a stub — its finding
	// must NOT be suppressed.
	for (const [start, end] of stubSkeletonRanges) {
		for (let line = start; line <= end; line++) {
			result.delete(line);
		}
	}

	return result;
}

// ============ Main Function ============

/**
 * Scan files for placeholder content (TODO/FIXME comments, stub implementations, etc.)
 */
export async function placeholderScan(
	input: PlaceholderScanInput,
	directory: string,
): Promise<PlaceholderScanResult> {
	const {
		changed_files,
		allow_globs,
		deny_patterns,
		added_lines,
		sentinel_allowlist,
		allow_sentinels,
	} = input;

	// Build sentinel allowlist as regex patterns for efficient matching
	const sentinelPatterns = [
		...DEFAULT_SENTINEL_ALLOWLIST,
		...(sentinel_allowlist ?? allow_sentinels ?? []),
	].map((sentinel) => new RegExp(escapeRegex(sentinel), 'i'));

	/**
	 * Check if an excerpt should be suppressed by the sentinel allowlist.
	 * Returns true if the excerpt contains any sentinel value (substring match).
	 */
	function isSentinelAllowed(excerpt: string): boolean {
		for (const pattern of sentinelPatterns) {
			if (pattern.test(excerpt)) {
				return true;
			}
		}
		return false;
	}

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

		// Get added lines for this file (normalized to relative path)
		const addedLinesForFile = normalizeAddedLines(
			added_lines?.[relativeFilePath] ?? added_lines?.[filePath],
		);

		// Use plan-specific scanner for .swarm/plan.md, parser for supported languages, regex fallback otherwise
		let fileFindings: PlaceholderFinding[];
		if (isPlanFile(filePath)) {
			fileFindings = scanPlanFileForPlaceholders(
				content,
				filePath,
				addedLinesForFile,
			);
		} else if (isParserSupported(filePath)) {
			fileFindings = await scanWithParser(
				content,
				filePath,
				denyPatterns,
				addedLinesForFile,
			);
		} else {
			fileFindings = scanWithRegex(
				content,
				filePath,
				denyPatterns,
				addedLinesForFile,
			);
		}

		// Filter out findings suppressed by sentinel allowlist
		const filteredFindings =
			sentinelPatterns.length > 0
				? fileFindings.filter((f) => !isSentinelAllowed(f.excerpt))
				: fileFindings;

		// Add findings to result
		if (filteredFindings.length > 0) {
			findings.push(...filteredFindings);
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
	allowWorkingDirectoryOverride: true,
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
		added_lines: z
			.record(z.string(), z.array(z.number().int().positive()))
			.optional()
			.describe('Optional map of file path to PR-added line numbers'),
		sentinel_allowlist: z
			.array(z.string())
			.optional()
			.describe('Intentional sentinel strings that suppress matching findings'),
		allow_sentinels: z
			.array(z.string())
			.optional()
			.describe('Deprecated alias for sentinel_allowlist'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		const result = await placeholderScan(
			args as PlaceholderScanInput,
			directory,
		);
		return JSON.stringify(result);
	},
});

/**
 * Internal seam for direct testing of the body-shape walker without
 * exercising the full placeholderScan pipeline. Mirrors the `_internals`
 * pattern from `src/lang/backends/typescript.ts:343-351` (AGENTS.md
 * invariant 7 — DI over `mock.module`).
 */
export const _internals = {
	collectNonStubBodyLines,
	isStubSkeletonFunction,
	isConstantLiteralNode,
} as const;
