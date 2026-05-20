import * as fs from 'node:fs';
import * as path from 'node:path';
import { tool } from '@opencode-ai/plugin';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { createSwarmTool } from './create-tool';
import { extractPythonSymbols, extractTSSymbols } from './symbols';

// Re-export SymbolInfo for use in batch results
export interface SymbolInfo {
	name: string;
	kind:
		| 'function'
		| 'class'
		| 'interface'
		| 'type'
		| 'enum'
		| 'const'
		| 'variable'
		| 'method'
		| 'property';
	exported: boolean;
	signature: string;
	line: number;
	jsdoc?: string;
}

// ============ Batch Result Types ============

export type FileErrorType =
	| 'file-not-found'
	| 'parse-error'
	| 'empty-file'
	| 'unsupported-language'
	| 'path-traversal'
	| 'path-outside-workspace'
	| 'invalid-path';

export interface FileSymbolResult {
	file: string;
	success: boolean;
	symbols?: SymbolInfo[];
	error?: string;
	errorType?: FileErrorType;
}

export interface BatchSymbolsResult {
	results: FileSymbolResult[];
	totalFiles: number;
	successCount: number;
	failureCount: number;
}

// ============ Constants (mirrored from symbols.ts) ============

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|:|$)/i;

// ============ Validation (reused from symbols.ts) ============

import {
	containsControlChars,
	containsPathTraversal,
} from '../utils/path-security';

/**
 * Check for Windows-specific path attacks:
 * - ADS (Alternate Data Streams) using : suffix
 * - Reserved device names
 */
function containsWindowsAttacks(str: string): boolean {
	// Check for ADS stream syntax (e.g., "file.txt:stream" or "file.txt:$DATA")
	if (/:[^\\/]/.test(str)) {
		return true;
	}
	// Check for reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
	// Split path and check each component
	const parts = str.split(/[/\\]/);
	for (const part of parts) {
		if (WINDOWS_RESERVED_NAMES.test(part)) {
			return true;
		}
	}
	return false;
}

/**
 * Check if path resolves within workspace using realpath to prevent symlink escape.
 * Validates the full resolved file path (not just parent directory) against workspace.
 */
function isPathInWorkspace(filePath: string, workspace: string): boolean {
	try {
		const resolvedPath = path.resolve(workspace, filePath);
		// If the file doesn't exist, return true — let the caller handle missing files
		if (!fs.existsSync(resolvedPath)) {
			return true;
		}
		const realWorkspace = fs.realpathSync(workspace);
		const realResolvedPath = fs.realpathSync(resolvedPath);
		const relativePath = path.relative(realWorkspace, realResolvedPath);
		if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

// ============ Single File Processing ============

/**
 * Process a single file and return its symbol result.
 * Does not throw - all errors are caught and returned as structured results.
 */
function processFile(
	file: string,
	cwd: string,
	exportedOnly: boolean,
): FileSymbolResult {
	const ext = path.extname(file);

	// Validate path contains no control characters
	if (containsControlChars(file)) {
		return {
			file,
			success: false,
			error: 'Path contains invalid control characters',
			errorType: 'invalid-path',
		};
	}

	// Validate path to stay within workspace
	if (containsPathTraversal(file)) {
		return {
			file,
			success: false,
			error: 'Path contains path traversal sequence',
			errorType: 'path-traversal',
		};
	}

	// Check for Windows-specific attacks (ADS streams, reserved device names)
	if (containsWindowsAttacks(file)) {
		return {
			file,
			success: false,
			error: 'Path contains invalid Windows-specific sequence',
			errorType: 'invalid-path',
		};
	}

	if (!isPathInWorkspace(file, cwd)) {
		return {
			file,
			success: false,
			error: 'Path is outside workspace',
			errorType: 'path-outside-workspace',
		};
	}

	const fullPath = path.join(cwd, file);
	if (!fs.existsSync(fullPath)) {
		return {
			file,
			success: false,
			error: `File not found: ${file}`,
			errorType: 'file-not-found',
		};
	}

	let syms: SymbolInfo[];

	switch (ext) {
		case '.ts':
		case '.tsx':
		case '.js':
		case '.jsx':
		case '.mjs':
		case '.cjs':
			syms = extractTSSymbols(file, cwd);
			break;
		case '.py':
			syms = extractPythonSymbols(file, cwd);
			break;
		default:
			return {
				file,
				success: false,
				error: `Unsupported file extension: ${ext}. Supported: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py`,
				errorType: 'unsupported-language',
			};
	}

	// Check for empty file (file exists but has no symbols)
	// This happens when the file exists but extraction returned empty
	let isEmptyFile = false;
	try {
		const stats = fs.statSync(fullPath);
		if (stats.size === 0) {
			isEmptyFile = true;
		}
	} catch {
		// File doesn't exist - this is handled by extract functions returning []
	}

	if (syms.length === 0) {
		// If we couldn't determine if it's empty but got no symbols,
		// it could be an empty file or a parse failure
		// Try to check if file has content
		try {
			const content = fs.readFileSync(fullPath, 'utf-8');
			if (content.trim().length === 0) {
				isEmptyFile = true;
			}
		} catch {
			// File read failed - error is already handled
		}
	}

	if (isEmptyFile) {
		return {
			file,
			success: true,
			symbols: [],
			error: 'empty-file',
			errorType: 'empty-file',
		};
	}

	if (exportedOnly) {
		syms = syms.filter((s) => s.exported);
	}

	return {
		file,
		success: true,
		symbols: syms,
	};
}

// ============ Tool Definition ============

export const batch_symbols: ToolDefinition = createSwarmTool({
	description:
		'Extract symbols from multiple files in a single batch call. ' +
		'Accepts an array of file paths and returns per-file symbol summaries. ' +
		'One bad file does not crash the batch. Use for surveying a module ' +
		'when you need symbol information from multiple files at once.',
	args: {
		files: tool.schema
			.array(tool.schema.string())
			.describe('Array of file paths to extract symbols from'),
		exported_only: tool.schema
			.boolean()
			.default(true)
			.describe(
				'If true, only return exported/public symbols. If false, include all top-level symbols.',
			),
	},
	execute: async (args: unknown, directory: string) => {
		// Safe args extraction - prevent crashes from malicious getters
		let files: string[];
		let exportedOnly = true;
		try {
			const obj = args as Record<string, unknown>;
			if (!Array.isArray(obj.files)) {
				return JSON.stringify(
					{
						results: [],
						totalFiles: 0,
						successCount: 0,
						failureCount: 0,
						error: 'Invalid arguments: files must be an array',
					},
					null,
					2,
				);
			}
			files = obj.files.map((f) => String(f));
			exportedOnly = obj.exported_only === true;
		} catch {
			return JSON.stringify(
				{
					results: [],
					totalFiles: 0,
					successCount: 0,
					failureCount: 0,
					error: 'Invalid arguments: could not extract files array',
				},
				null,
				2,
			);
		}

		const cwd = directory;
		const results: FileSymbolResult[] = [];

		// Process each file, collecting results
		// Stable ordering: maintain input order in results
		for (const file of files) {
			const result = processFile(file, cwd, exportedOnly);
			results.push(result);
		}

		// Calculate summary counts
		const successCount = results.filter((r) => r.success).length;
		const failureCount = results.filter((r) => !r.success).length;

		const batchResult: BatchSymbolsResult = {
			results,
			totalFiles: files.length,
			successCount,
			failureCount,
		};

		return JSON.stringify(batchResult, null, 2);
	},
});
