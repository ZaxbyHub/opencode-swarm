import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createSwarmTool } from './create-tool';

// ============ Constants ============
const MAX_FILE_PATH_LENGTH = 500;
const MAX_SYMBOL_LENGTH = 256;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB per file
const MAX_CONSUMERS = 100;
const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// Binary file signatures to detect
const BINARY_SIGNATURES = [
	0x00_00_00_00, // null
	0x89_50_4e_47, // PNG
	0xff_d8_ff_e0, // JPEG
	0x47_49_46_38, // GIF
	0x25_50_44_46, // PDF
	0x50_4b_03_04, // ZIP/JAR
];

// Binary detection constants
const BINARY_PREFIX_BYTES = 4; // Number of bytes to check for file signatures
const BINARY_NULL_CHECK_BYTES = 8192; // Number of bytes to check for null bytes
const BINARY_NULL_THRESHOLD = 0.1; // 10% null bytes threshold for binary detection

// ============ Validation ============
import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';

function validateFileInput(file: string): string | null {
	if (!file || file.length === 0) {
		return 'file is required';
	}
	if (file.length > MAX_FILE_PATH_LENGTH) {
		return `file exceeds maximum length of ${MAX_FILE_PATH_LENGTH}`;
	}
	if (containsControlChars(file)) {
		return 'file contains control characters';
	}
	if (containsPathTraversal(file)) {
		return 'file contains path traversal';
	}
	return null;
}

function validateSymbolInput(symbol: string | undefined): string | null {
	if (symbol === undefined || symbol === '') {
		return null; // optional
	}
	if (symbol.length > MAX_SYMBOL_LENGTH) {
		return `symbol exceeds maximum length of ${MAX_SYMBOL_LENGTH}`;
	}
	if (containsControlChars(symbol)) {
		return 'symbol contains control characters';
	}
	if (containsPathTraversal(symbol)) {
		return 'symbol contains path traversal';
	}
	return null;
}

// ============ File Detection ============
function isBinaryFile(filePath: string, buffer: Buffer): boolean {
	// Check file extension first (case-normalized)
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.json' || ext === '.md' || ext === '.txt') {
		return false;
	}

	// Check first few bytes for binary signatures
	if (buffer.length >= BINARY_PREFIX_BYTES) {
		const prefix = buffer.subarray(0, BINARY_PREFIX_BYTES);
		const uint32 = prefix.readUInt32BE(0);
		for (const sig of BINARY_SIGNATURES) {
			if (uint32 === sig) return true;
		}
	}

	// Check for null bytes in content (common binary indicator)
	let nullCount = 0;
	const checkLen = Math.min(buffer.length, BINARY_NULL_CHECK_BYTES);
	for (let i = 0; i < checkLen; i++) {
		if (buffer[i] === 0) nullCount++;
	}
	// If more than threshold null bytes, likely binary
	return nullCount > checkLen * BINARY_NULL_THRESHOLD;
}

// ============ Import Parsing ============
interface ImportMatch {
	line: number;
	imports: string;
	importType: 'default' | 'named' | 'namespace' | 'require' | 'sideeffect';
	raw: string;
}

/**
 * Parse imports from a file content
 * Returns array of import matches with line numbers
 */
function parseImports(
	content: string,
	targetFile: string,
	targetSymbol?: string,
): ImportMatch[] {
	const imports: ImportMatch[] = [];

	// Resolve the target file to absolute path for comparison
	let _resolvedTarget: string;
	try {
		_resolvedTarget = path.resolve(targetFile);
	} catch {
		_resolvedTarget = targetFile;
	}

	// Get the base name without extension for matching
	const targetBasename = path.basename(targetFile, path.extname(targetFile));

	// Normalize target for comparison (with and without extension)
	const targetWithExt = targetFile;
	const targetWithoutExt = targetFile.replace(
		/\.(ts|tsx|js|jsx|mjs|cjs)$/i,
		'',
	);

	// Normalize target path for cross-platform comparison
	const normalizedTargetWithExt = path
		.normalize(targetWithExt)
		.replace(/\\/g, '/');
	const normalizedTargetWithoutExt = path
		.normalize(targetWithoutExt)
		.replace(/\\/g, '/');

	// Combine all import regex patterns to find all import statements
	// This handles multiline imports by scanning the entire content
	// Handles: import { x } from '...', import x from '...', import * as x from '...', import '...', require('...')
	const importRegex =
		/import\s+(?:\{[\s\S]*?\}|(?:\*\s+as\s+\w+)|\w+)\s+from\s+['"`]([^'"`]+)['"`]|import\s+['"`]([^'"`]+)['"`]|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

	for (
		let match = importRegex.exec(content);
		match !== null;
		match = importRegex.exec(content)
	) {
		// Extract the module path (from any of the capture groups)
		const modulePath = match[1] || match[2] || match[3];
		if (!modulePath) continue;

		// Get the line number by counting newlines before the match
		const beforeMatch = content.substring(0, match.index);
		const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

		// Get the matched string for type detection
		const matchedString = match[0];

		// Determine import type - check the actual import syntax
		let importType: ImportMatch['importType'] = 'named';
		if (matchedString.includes('* as')) {
			importType = 'namespace';
		} else if (/^import\s+\{/.test(matchedString)) {
			// Named import: import { Foo } from '...' - NOT default
			importType = 'named';
		} else if (/^import\s+\w+\s+from\s+['"`]/.test(matchedString)) {
			// Default import: import foo from '...'
			importType = 'default';
		} else if (/^import\s+['"`]/m.test(matchedString)) {
			// Side-effect import: import '...' (no from with specifier)
			// This is ES module side-effect only import, NOT CommonJS require
			importType = 'sideeffect';
		} else if (matchedString.includes('require(')) {
			importType = 'require';
		}

		// Normalize module path for comparison
		const _normalizedModule = modulePath
			.replace(/^\.\//, '')
			.replace(/^\.\.\\/, '../');

		// Check if this import matches our target
		let isMatch = false;

		// Get target file info for robust matching
		const _targetDir = path.dirname(targetFile);
		const targetExt = path.extname(targetFile);
		const targetBasenameNoExt = path.basename(targetFile, targetExt);

		// Build multiple normalized forms for matching
		const moduleNormalized = modulePath
			.replace(/\\/g, '/')
			.replace(/^\.\//, '');

		// Extract module name (last segment) for relative path matching
		const moduleName = modulePath.split(/[/\\]/).pop() || '';
		const moduleNameNoExt = moduleName.replace(
			/\.(ts|tsx|js|jsx|mjs|cjs)$/i,
			'',
		);

		// Check various matching forms:
		// 1. Exact match with/without ./ prefix
		// 2. Match without extension (./utils matches ./utils.ts)
		// 3. Match with extension (.utils.ts matches ./utils.ts)
		// 4. Full absolute path comparison
		if (
			modulePath === targetBasename ||
			modulePath === targetBasenameNoExt ||
			modulePath === `./${targetBasename}` ||
			modulePath === `./${targetBasenameNoExt}` ||
			modulePath === `../${targetBasename}` ||
			modulePath === `../${targetBasenameNoExt}` ||
			moduleNormalized === normalizedTargetWithExt ||
			moduleNormalized === normalizedTargetWithoutExt ||
			modulePath.endsWith(`/${targetBasename}`) ||
			modulePath.endsWith(`\\${targetBasename}`) ||
			modulePath.endsWith(`/${targetBasenameNoExt}`) ||
			modulePath.endsWith(`\\${targetBasenameNoExt}`) ||
			// Extension-less import matching (./utils matches ./utils.ts)
			moduleNameNoExt === targetBasenameNoExt ||
			`./${moduleNameNoExt}` === targetBasenameNoExt ||
			moduleName === targetBasename ||
			moduleName === targetBasenameNoExt
		) {
			isMatch = true;
		}

		// If symbol is specified, also check if it's being imported
		// Supports: import { Foo } - matches Foo
		//           import { Foo as Bar } - matches both Foo and Bar
		//           import Foo from - matches Foo (default import)
		// Note: namespace imports (import * as ns from '...') do NOT match when symbol is specified
		//       because they don't export specific symbols
		if (isMatch && targetSymbol) {
			// Namespace imports cannot match specific symbols
			if (importType === 'namespace' || importType === 'sideeffect') {
				isMatch = false;
			} else {
				// Extract the imported names from the import statement (handles multiline)
				const namedMatch = matchedString.match(
					/import\s+\{([\s\S]*?)\}\s+from/,
				);
				if (namedMatch) {
					// Parse named imports with optional aliases
					// Match both original name and alias (e.g., "Foo as Bar" or just "Foo")
					const importedNames = namedMatch[1].split(',').map((s) => {
						const parts = s.trim().split(/\s+as\s+/i);
						const originalName = parts[0].trim();
						const aliasName = parts[1]?.trim();
						return { original: originalName, alias: aliasName };
					});

					// Check if target symbol matches either the original name or the alias
					isMatch = importedNames.some(
						({ original, alias }) =>
							original === targetSymbol || alias === targetSymbol,
					);
				} else if (importType === 'default') {
					// Default import: import Foo from '...'
					// Extract the default binding name
					const defaultMatch = matchedString.match(/^import\s+(\w+)\s+from/m);
					if (defaultMatch) {
						const defaultName = defaultMatch[1];
						// For default imports, targetSymbol should match the default binding
						isMatch = defaultName === targetSymbol;
					}
				}
			}
		}

		if (isMatch) {
			imports.push({
				line: lineNum,
				imports: modulePath,
				importType,
				raw: matchedString.trim(),
			});
		}
	}

	return imports;
}

// ============ Directory Scanning ============
interface ConsumerFile {
	file: string;
	line: number;
	imports: string;
	importType: 'default' | 'named' | 'namespace' | 'require' | 'sideeffect';
	raw: string;
}

interface ImportsResult {
	target: string;
	symbol?: string;
	consumers: ConsumerFile[];
	count: number;
	message?: string;
}

interface ImportsErrorResult {
	error: string;
	target: string;
	symbol?: string;
	consumers: [];
	count: 0;
}

// Directories to skip during scanning (build artifacts, package managers, etc.)
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.nuxt',
	'.cache',
	'vendor',
	'.svn',
	'.hg',
]);

/**
 * Recursively find all supported source files in a directory
 */
interface ScanStats {
	skippedDirs: string[];
	skippedFiles: number;
	fileErrors: { path: string; reason: string }[];
}

function findSourceFiles(
	dir: string,
	files: string[] = [],
	stats: ScanStats = { skippedDirs: [], skippedFiles: 0, fileErrors: [] },
): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (e) {
		stats.fileErrors.push({
			path: dir,
			reason: e instanceof Error ? e.message : 'readdir failed',
		});
		return files;
	}

	// Sort entries for deterministic scan order (case-insensitive)
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	for (const entry of entries) {
		// Skip only specific non-source directories, not all dot-prefixed entries
		// This allows hidden config files like .eslintrc to be scanned
		if (SKIP_DIRECTORIES.has(entry)) {
			stats.skippedDirs.push(path.join(dir, entry));
			continue;
		}

		const fullPath = path.join(dir, entry);

		let stat: fs.Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch (e) {
			stats.fileErrors.push({
				path: fullPath,
				reason: e instanceof Error ? e.message : 'stat failed',
			});
			continue;
		}

		if (stat.isDirectory()) {
			findSourceFiles(fullPath, files, stats);
		} else if (stat.isFile()) {
			const ext = path.extname(fullPath).toLowerCase();
			if (SUPPORTED_EXTENSIONS.includes(ext)) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

/**
 * Main imports tool implementation
 */
export const imports: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Find all reverse dependencies (consumers) that import from a given file. Returns JSON with file path, line numbers, and import metadata for each consumer. Use this to understand who depends on a module before refactoring.',
	args: {
		file: z
			.string()
			.describe(
				'Source file path to find importers for (e.g., "./src/utils.ts")',
			),
		symbol: z
			.string()
			.optional()
			.describe('Optional specific symbol to filter imports (e.g., "MyClass")'),
	},
	async execute(
		args: unknown,
		_directory: string,
		_ctx?: ToolContext,
	): Promise<string> {
		const typedArgs = args as { file: string; symbol?: string };
		// Safe args extraction - guard against malformed args and malicious getters
		let file: string | undefined;
		let symbol: string | undefined;
		try {
			if (typedArgs && typeof typedArgs === 'object') {
				file = typedArgs.file;
				symbol = typedArgs.symbol;
			}
		} catch {
			// Malicious getter threw - treat as malformed args
		}

		// Handle malformed args: return structured error
		if (file === undefined) {
			const errorResult: ImportsErrorResult = {
				error: 'invalid arguments: file is required',
				target: '',
				symbol: undefined,
				consumers: [],
				count: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		// Validate inputs - use safely extracted file and symbol
		const fileValidationError = validateFileInput(file);
		if (fileValidationError) {
			const errorResult: ImportsErrorResult = {
				error: `invalid file: ${fileValidationError}`,
				target: file,
				symbol: symbol,
				consumers: [],
				count: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const symbolValidationError = validateSymbolInput(symbol);
		if (symbolValidationError) {
			const errorResult: ImportsErrorResult = {
				error: `invalid symbol: ${symbolValidationError}`,
				target: file,
				symbol: symbol,
				consumers: [],
				count: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}

		try {
			// Resolve the target file to an absolute path
			const targetFile = path.resolve(file);

			// Check if target file exists
			if (!fs.existsSync(targetFile)) {
				const errorResult: ImportsErrorResult = {
					error: `target file not found: ${file}`,
					target: file,
					symbol: symbol,
					consumers: [],
					count: 0,
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Check if target is a file (not directory)
			const targetStat = fs.statSync(targetFile);
			if (!targetStat.isFile()) {
				const errorResult: ImportsErrorResult = {
					error: 'target must be a file, not a directory',
					target: file,
					symbol: symbol,
					consumers: [],
					count: 0,
				};
				return JSON.stringify(errorResult, null, 2);
			}

			// Get the directory containing the target file
			const baseDir = path.dirname(targetFile);

			// Find all source files in the project
			const scanStats: ScanStats = {
				skippedDirs: [],
				skippedFiles: 0,
				fileErrors: [],
			};
			const sourceFiles = findSourceFiles(baseDir, [], scanStats);

			// Filter out the target file itself and sort for deterministic scan order
			const filesToScan = sourceFiles
				.filter((f) => f !== targetFile)
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
				.slice(0, MAX_CONSUMERS * 10); // Allow scanning more than we return

			const consumers: ConsumerFile[] = [];
			let skippedFileCount = 0;
			let totalMatchesFound = 0; // Track all matches before deduping/limiting

			for (const filePath of filesToScan) {
				if (consumers.length >= MAX_CONSUMERS) break;

				try {
					// Read file with size check
					const stat = fs.statSync(filePath);
					if (stat.size > MAX_FILE_SIZE_BYTES) {
						skippedFileCount++;
						continue; // Skip oversized files
					}

					// Read file content
					const buffer = fs.readFileSync(filePath);

					// Skip binary files
					if (isBinaryFile(filePath, buffer)) {
						skippedFileCount++;
						continue;
					}

					const content = buffer.toString('utf-8');

					// Parse imports from this file
					const fileImports = parseImports(content, targetFile, symbol);

					// Add matching imports as consumers
					for (const imp of fileImports) {
						totalMatchesFound++;

						// Skip if already at limit
						if (consumers.length >= MAX_CONSUMERS) continue;

						// Deduplicate by file + line combination (deterministic)
						const exists = consumers.some(
							(c) => c.file === filePath && c.line === imp.line,
						);
						if (exists) continue;

						consumers.push({
							file: filePath,
							line: imp.line,
							imports: imp.imports,
							importType: imp.importType,
							raw: imp.raw,
						});
					}
				} catch (_e) {
					skippedFileCount++;
				}
			}

			const result: ImportsResult = {
				target: file,
				symbol: symbol,
				consumers,
				count: consumers.length,
			};

			// Build detailed message for truncated/skipping results
			const parts: string[] = [];
			if (filesToScan.length >= MAX_CONSUMERS * 10) {
				parts.push(`Scanned ${filesToScan.length} files`);
			}
			if (skippedFileCount > 0) {
				parts.push(`${skippedFileCount} skipped (size/binary/errors)`);
			}
			if (consumers.length >= MAX_CONSUMERS) {
				const hidden = totalMatchesFound - consumers.length;
				if (hidden > 0) {
					parts.push(
						`Results limited to ${MAX_CONSUMERS} consumers (${hidden} hidden)`,
					);
				} else {
					parts.push(`Results limited to ${MAX_CONSUMERS} consumers`);
				}
			}
			if (parts.length > 0) {
				result.message = `${parts.join('; ')}.`;
			}

			return JSON.stringify(result, null, 2);
		} catch (e) {
			const errorResult: ImportsErrorResult = {
				error:
					e instanceof Error
						? `scan failed: ${e.message || 'internal error'}`
						: 'scan failed: unknown error',
				target: file,
				symbol: symbol,
				consumers: [],
				count: 0,
			};
			return JSON.stringify(errorResult, null, 2);
		}
	},
});
