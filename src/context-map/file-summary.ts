/**
 * File Summary Population Module
 *
 * Incrementally builds FileContextEntry records as agents interact with files.
 * Uses lightweight regex-based analysis (no external tool calls) to extract
 * exports, imports, language, and purpose summaries from source content.
 *
 * All functions are synchronous and bounded — no filesystem scans,
 * no subprocess calls, no network requests. This module is designed
 * to be fast enough to call on every file an agent touches.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileContextEntry } from '../types/context-map';
import { computeContentHash } from './persistence';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/**
 * Maps file extensions to language identifiers.
 * Used by detectLanguage to identify the programming language of a file.
 */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.py': 'python',
	'.rs': 'rust',
	'.go': 'go',
	'.json': 'json',
	'.md': 'markdown',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.css': 'css',
	'.scss': 'scss',
	'.html': 'html',
	'.sh': 'shell',
	'.bash': 'shell',
	'.ps1': 'powershell',
};

/**
 * Detect the programming language of a file from its extension.
 *
 * @param filePath - Relative or absolute file path
 * @returns Language identifier string, or undefined if the extension is unrecognized
 */
export function detectLanguage(filePath: string): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	return EXTENSION_LANGUAGE_MAP[ext];
}

// ---------------------------------------------------------------------------
// Regex patterns — exported as named constants for testability
// ---------------------------------------------------------------------------

/**
 * Matches named ESM exports: "export function foo", "export class Bar", etc.
 * Capture group 1: the exported symbol name.
 */
export const RE_EXPORT_NAMED =
	/export\s+(?:function|class|interface|type|const|let|var|enum)\s+(\w+)/g;

/**
 * Matches brace-delimited ESM re-exports: "export { foo, bar }".
 * Capture group 1: the comma-separated symbol list inside braces.
 */
export const RE_EXPORT_BRACE = /export\s*\{\s*([\w,\s]+)\s*\}/g;

/**
 * Matches ESM import statements: "import ... from '...'".
 * Capture group 1: the module specifier (source path).
 */
export const RE_IMPORT_FROM = /import\s+.*?\s+from\s+['"](.+?)['"]/g;

/**
 * Matches CommonJS require calls: "require('...')".
 * Capture group 1: the module specifier.
 */
export const RE_IMPORT_REQUIRE = /require\(\s*['"](.+?)['"]\s*\)/g;

/**
 * Matches the first JSDoc or block comment in a file.
 * Capture group 1: the comment body (between slash-star and star-slash).
 */
export const RE_FIRST_COMMENT = /\/\*(.+?)\*\//s;

/**
 * Maximum number of key symbols to retain per file entry.
 */
export const MAX_KEY_SYMBOLS = 10;

/**
 * Maximum character length for purpose summaries.
 */
export const MAX_PURPOSE_LENGTH = 200;

// ---------------------------------------------------------------------------
// Summary extraction
// ---------------------------------------------------------------------------

/**
 * Build a complete FileContextEntry from file content.
 *
 * Computes content hash, detects language, extracts exports/imports,
 * generates a purpose summary from the first JSDoc comment, and
 * identifies key symbols from export names.
 *
 * When an existing entry is provided, mutable fields (hash, language,
 * purpose, exports, imports, summary, mtime) are refreshed while
 * accumulated fields (invariants, risks, tests, last_seen_task_ids)
 * are preserved.
 *
 * @param filePath - Relative file path within the project
 * @param content - Full file content as a string
 * @param absolutePath - Optional absolute path for filesystem stat (avoids process.cwd() resolution)
 * @param existingEntry - Optional previous entry to merge with
 * @returns A complete FileContextEntry
 */
export function extractFileSummary(
	filePath: string,
	content: string,
	absolutePath?: string,
	existingEntry?: FileContextEntry,
): FileContextEntry {
	const contentHash = computeContentHash(content);
	const language = detectLanguage(filePath);
	const exportsList = extractExports(content);
	const importsList = extractImports(content);
	const purpose = extractPurpose(content);

	const keySymbols = exportsList.slice(0, MAX_KEY_SYMBOLS);

	// Get mtime from the resolved absolute path when provided, otherwise default to 0
	let mtimeMs = 0;
	if (absolutePath) {
		try {
			const stat = fs.statSync(absolutePath);
			mtimeMs = stat.mtimeMs;
		} catch {
			// File may not be accessible — use default
		}
	}

	const base: FileContextEntry = {
		path: filePath,
		content_hash: contentHash,
		mtime_ms: mtimeMs,
		language: language,
		purpose: purpose,
		exports: exportsList.length > 0 ? exportsList : undefined,
		imports: importsList.length > 0 ? importsList : undefined,
		key_symbols: keySymbols.length > 0 ? keySymbols : undefined,
		summary: purpose,
	};

	// If an existing entry is provided, preserve accumulated fields
	if (existingEntry) {
		return {
			...base,
			invariants: existingEntry.invariants,
			risks: existingEntry.risks,
			tests: existingEntry.tests,
			last_seen_task_ids: existingEntry.last_seen_task_ids,
		};
	}

	return base;
}

// ---------------------------------------------------------------------------
// Batch population
// ---------------------------------------------------------------------------

/**
 * Populate FileContextEntry records for multiple files at once.
 *
 * For each file path, reads content from directory + path, calls
 * extractFileSummary, and collects the result. Skips files that
 * don't exist or can't be read.
 *
 * When an existing map is provided, entries are merged: new extractions
 * take precedence for mutable fields while accumulated fields from
 * existing entries are preserved.
 *
 * @param filePaths - Array of relative file paths to populate
 * @param directory - Project root directory to resolve file paths against
 * @param existingMap - Optional map of previously populated entries to merge with
 * @returns Record mapping file paths to their FileContextEntry instances
 */
export function batchPopulateSummaries(
	filePaths: string[],
	directory: string,
	existingMap?: Record<string, FileContextEntry>,
): Record<string, FileContextEntry> {
	const result: Record<string, FileContextEntry> = { ...existingMap };

	for (const relativePath of filePaths) {
		const absolutePath = path.join(directory, relativePath);

		if (!fs.existsSync(absolutePath)) {
			continue;
		}

		try {
			const content = fs.readFileSync(absolutePath, 'utf-8');
			const existingEntry = existingMap?.[relativePath];
			result[relativePath] = extractFileSummary(
				relativePath,
				content,
				absolutePath,
				existingEntry,
			);
		} catch {}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

/**
 * Check whether a stored context map entry is stale relative to current content.
 *
 * Compares the stored content_hash against a fresh SHA-256 hash of the
 * provided current content. Returns true if the hashes differ, indicating
 * the file has been modified since the entry was last populated.
 *
 * @param entry - The stored FileContextEntry to check
 * @param currentContent - The current file content to compare against
 * @returns true if the entry is stale (hashes differ), false if still current
 */
export function isFileStale(
	entry: FileContextEntry,
	currentContent: string,
): boolean {
	const currentHash = computeContentHash(currentContent);
	return entry.content_hash !== currentHash;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract exported symbol names from source content.
 * Matches both named exports (e.g. "export function foo") and
 * brace-delimited exports (e.g. "export { foo, bar }").
 */
function extractExports(content: string): string[] {
	const symbols: string[] = [];

	// Named exports: export function/class/interface/type/const/let/var/enum name
	const namedRe = new RegExp(RE_EXPORT_NAMED.source, 'g');
	let match: RegExpExecArray | null;
	match = namedRe.exec(content);
	while (match !== null) {
		symbols.push(match[1]);
		match = namedRe.exec(content);
	}

	// Brace exports: export { foo, bar, baz }
	const braceRe = new RegExp(RE_EXPORT_BRACE.source, 'g');
	match = braceRe.exec(content);
	while (match !== null) {
		const list = match[1];
		for (const name of list.split(',')) {
			const trimmed = name.trim();
			if (trimmed) {
				symbols.push(trimmed);
			}
		}
		match = braceRe.exec(content);
	}

	return symbols;
}

/**
 * Extract import module specifiers from source content.
 * Matches ESM imports (e.g. "import ... from 'path'") and
 * CommonJS requires (e.g. "require('path')").
 */
function extractImports(content: string): string[] {
	const specifiers: string[] = [];

	const fromRe = new RegExp(RE_IMPORT_FROM.source, 'g');
	let match: RegExpExecArray | null;
	match = fromRe.exec(content);
	while (match !== null) {
		specifiers.push(match[1]);
		match = fromRe.exec(content);
	}

	const requireRe = new RegExp(RE_IMPORT_REQUIRE.source, 'g');
	match = requireRe.exec(content);
	while (match !== null) {
		specifiers.push(match[1]);
		match = requireRe.exec(content);
	}

	return specifiers;
}

/**
 * Extract a brief purpose summary from the first JSDoc or block comment.
 * Strips leading asterisks and whitespace, collapses internal newlines,
 * and truncates to MAX_PURPOSE_LENGTH characters.
 *
 * Returns "No summary available" if no comment block is found.
 */
function extractPurpose(content: string): string {
	const match = RE_FIRST_COMMENT.exec(content);
	if (!match) {
		return 'No summary available';
	}

	// Strip leading asterisk pattern lines, collapse whitespace
	let body = match[1]
		.split('\n')
		.map((line) => line.replace(/^\s*\*\s?/, '').trim())
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (body.length > MAX_PURPOSE_LENGTH) {
		body = `${body.substring(0, MAX_PURPOSE_LENGTH)}...`;
	}

	return body || 'No summary available';
}
