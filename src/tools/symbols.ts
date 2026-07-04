import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { collectPythonAllNames } from '../lang/symbol-visibility';
import { createSwarmTool } from './create-tool';

interface SymbolInfo {
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

// ============ Constants ============
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB per file
const MAX_WORKSPACE_RESULTS = 50;
const MAX_WORKSPACE_SCANNED_FILES = 200;
const WORKSPACE_TIMEOUT_MS = 10_000;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|:|$)/i;

// Extensions supported for symbol extraction
const SYMBOL_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.py',
	'.pyw',
	'.rs',
	'.go',
]);

// Directories to skip during workspace scanning
const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'.next',
	'coverage',
	'__pycache__',
]);

// ============ Workspace Types ============

interface WorkspaceFileSummary {
	file: string;
	symbolCount: number;
	symbols: SymbolInfo[];
}

interface WorkspaceResult {
	query: { workspace: boolean; name?: string };
	fileCount: number;
	scannedFileCount: number;
	totalSymbols: number;
	files: WorkspaceFileSummary[];
	truncated: boolean;
}

// ============ Validation ============

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
		// Resolve the file path relative to workspace
		const resolvedPath = path.resolve(workspace, filePath);

		// Get realpath of the FULL resolved path to handle symlinks in the file itself
		const realWorkspace = fs.realpathSync(workspace);
		const realResolvedPath = fs.realpathSync(resolvedPath);

		// Use robust path.relative containment test against workspace realpath
		const relativePath = path.relative(realWorkspace, realResolvedPath);

		// If relative path starts with .., it's outside workspace
		if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Re-validate that path is still within workspace immediately before file access.
 * This prevents TOCTOU attacks where symlinks could be modified between validation and read.
 */
function validatePathForRead(filePath: string, workspace: string): boolean {
	return isPathInWorkspace(filePath, workspace);
}

function readValidatedSourceFile(filePath: string, cwd: string): string | null {
	const fullPath = path.join(cwd, filePath);
	if (!validatePathForRead(fullPath, cwd)) return null;

	try {
		const stats = fs.statSync(fullPath);
		if (stats.size > MAX_FILE_SIZE_BYTES) return null;
		return fs.readFileSync(fullPath, 'utf-8');
	} catch {
		return null;
	}
}

// ============ TypeScript/JavaScript Extraction ============

/**
 * Extract symbols from a TypeScript/JavaScript file using regex-based parsing.
 * Handles: export function, export const, export class, export interface,
 * export type, export enum, export default, and class members.
 */
export function extractTSSymbols(filePath: string, cwd: string): SymbolInfo[] {
	const fullPath = path.join(cwd, filePath);

	// Re-validate path right before file read to catch any TOCTOU issues
	if (!validatePathForRead(fullPath, cwd)) {
		return [];
	}

	// Reduce TOCTOU: use single try-catch for exists+stat+read instead of separate checks
	let content: string;
	try {
		const stats = fs.statSync(fullPath);
		if (stats.size > MAX_FILE_SIZE_BYTES) {
			throw new Error(
				`File too large: ${stats.size} bytes (max: ${MAX_FILE_SIZE_BYTES})`,
			);
		}
		content = fs.readFileSync(fullPath, 'utf-8');
	} catch {
		return [];
	}

	const lines = content.split('\n');
	const symbols: SymbolInfo[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Collect JSDoc comment above this line
		let jsdoc: string | undefined;
		if (i > 0 && lines[i - 1].trim().endsWith('*/')) {
			const jsdocLines: string[] = [];
			for (let j = i - 1; j >= 0; j--) {
				jsdocLines.unshift(lines[j]);
				if (lines[j].trim().startsWith('/**')) break;
			}
			jsdoc = jsdocLines.join('\n').trim();
			if (jsdoc.length > 300) jsdoc = `${jsdoc.substring(0, 300)}...`;
		}

		// Exported function
		const fnMatch = line.match(
			/^export\s+(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*(.+?))?(?:\s*\{|$)/,
		);
		if (fnMatch) {
			symbols.push({
				name: fnMatch[1],
				kind: 'function',
				exported: true,
				signature: `function ${fnMatch[1]}${fnMatch[2] || ''}(${fnMatch[3].trim()})${fnMatch[4] ? `: ${fnMatch[4].trim()}` : ''}`,
				line: lineNum,
				jsdoc,
			});
			continue;
		}

		// Exported const (with type annotation or arrow function)
		const constMatch = line.match(
			/^export\s+const\s+(\w+)(?:\s*:\s*(.+?))?\s*=/,
		);
		if (constMatch) {
			// Check if it's an arrow function
			const restOfLine = line.substring(line.indexOf('=') + 1).trim();
			const isArrow =
				restOfLine.startsWith('(') ||
				restOfLine.startsWith('async (') ||
				restOfLine.match(/^\w+\s*=>/);
			symbols.push({
				name: constMatch[1],
				kind: isArrow ? 'function' : 'const',
				exported: true,
				signature: `const ${constMatch[1]}${constMatch[2] ? `: ${constMatch[2].trim()}` : ''}`,
				line: lineNum,
				jsdoc,
			});
			continue;
		}

		// Exported class
		const classMatch = line.match(
			/^export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)\s+(.+?))?(?:\s*\{|$)/,
		);
		if (classMatch) {
			symbols.push({
				name: classMatch[1],
				kind: 'class',
				exported: true,
				signature: `class ${classMatch[1]}${classMatch[2] ? ` extends/implements ${classMatch[2].trim()}` : ''}`,
				line: lineNum,
				jsdoc,
			});

			// Scan class body for public members
			let braceDepth =
				(line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
			for (let j = i + 1; j < lines.length && braceDepth > 0; j++) {
				const memberLine = lines[j];
				braceDepth +=
					(memberLine.match(/\{/g) || []).length -
					(memberLine.match(/\}/g) || []).length;

				// Public method
				const methodMatch = memberLine.match(
					/^\s+(?:public\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*(.+?))?(?:\s*\{|;|$)/,
				);
				if (
					methodMatch &&
					!memberLine.includes('private') &&
					!memberLine.includes('protected') &&
					!memberLine.trim().startsWith('//')
				) {
					symbols.push({
						name: `${classMatch[1]}.${methodMatch[1]}`,
						kind: 'method',
						exported: true,
						signature: `${methodMatch[1]}(${methodMatch[2].trim()})${methodMatch[3] ? `: ${methodMatch[3].trim()}` : ''}`,
						line: j + 1,
					});
				}

				// Public property
				const propMatch = memberLine.match(
					/^\s+(?:public\s+)?(?:readonly\s+)?(\w+)(?:\?)?:\s*(.+?)(?:\s*[;=]|$)/,
				);
				if (
					propMatch &&
					!memberLine.includes('private') &&
					!memberLine.includes('protected') &&
					!memberLine.trim().startsWith('//')
				) {
					symbols.push({
						name: `${classMatch[1]}.${propMatch[1]}`,
						kind: 'property',
						exported: true,
						signature: `${propMatch[1]}: ${propMatch[2].trim()}`,
						line: j + 1,
					});
				}
			}
			continue;
		}

		// Exported interface
		const ifaceMatch = line.match(
			/^export\s+interface\s+(\w+)(?:\s*<([^>]+)>)?(?:\s+extends\s+(.+?))?(?:\s*\{|$)/,
		);
		if (ifaceMatch) {
			symbols.push({
				name: ifaceMatch[1],
				kind: 'interface',
				exported: true,
				signature: `interface ${ifaceMatch[1]}${ifaceMatch[2] ? `<${ifaceMatch[2]}>` : ''}${ifaceMatch[3] ? ` extends ${ifaceMatch[3].trim()}` : ''}`,
				line: lineNum,
				jsdoc,
			});
			continue;
		}

		// Exported type
		const typeMatch = line.match(/^export\s+type\s+(\w+)(?:\s*<([^>]+)>)?\s*=/);
		if (typeMatch) {
			const typeValue = line
				.substring(line.indexOf('=') + 1)
				.trim()
				.substring(0, 100);
			symbols.push({
				name: typeMatch[1],
				kind: 'type',
				exported: true,
				signature: `type ${typeMatch[1]}${typeMatch[2] ? `<${typeMatch[2]}>` : ''} = ${typeValue}`,
				line: lineNum,
				jsdoc,
			});
			continue;
		}

		// Exported enum
		const enumMatch = line.match(/^export\s+(?:const\s+)?enum\s+(\w+)/);
		if (enumMatch) {
			symbols.push({
				name: enumMatch[1],
				kind: 'enum',
				exported: true,
				signature: `enum ${enumMatch[1]}`,
				line: lineNum,
				jsdoc,
			});
			continue;
		}

		// Export default
		const defaultMatch = line.match(
			/^export\s+default\s+(?:function\s+)?(\w+)/,
		);
		if (defaultMatch) {
			symbols.push({
				name: defaultMatch[1],
				kind: 'function',
				exported: true,
				signature: `default ${defaultMatch[1]}`,
				line: lineNum,
				jsdoc,
			});
		}
	}

	// Sort by line number for deterministic ordering, with tie-breaker on symbol name
	return symbols.sort((a, b) => {
		if (a.line !== b.line) return a.line - b.line;
		return a.name.localeCompare(b.name);
	});
}

// ============ Python Extraction ============

/**
 * Extract symbols from a Python file.
 */
export function extractPythonSymbols(
	filePath: string,
	cwd: string,
): SymbolInfo[] {
	const content = readValidatedSourceFile(filePath, cwd);
	if (content === null) return [];

	const lines = content.split('\n');
	const symbols: SymbolInfo[] = [];

	const explicitExports = collectPythonAllNames(content);
	const isExplicitlyExported = (name: string): boolean =>
		explicitExports ? explicitExports.has(name) : !name.startsWith('_');
	const isPackageInit = ['__init__.py', '__init__.pyw'].includes(
		path.basename(filePath),
	);
	const seenNames = new Set<string>();
	let currentClass: { name: string; exported: boolean; indent: number } | null =
		null;
	const addSymbol = (symbol: SymbolInfo) => {
		if (seenNames.has(symbol.name)) return;
		seenNames.add(symbol.name);
		symbols.push(symbol);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const indent = line.match(/^\s*/)?.[0].length ?? 0;
		if (indent === 0) currentClass = null;
		if (currentClass && indent > currentClass.indent) {
			const methodMatch = line
				.trim()
				.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?:/);
			if (methodMatch) {
				const name = `${currentClass.name}.${methodMatch[1]}`;
				addSymbol({
					name,
					kind: 'method',
					exported:
						currentClass.exported &&
						!methodMatch[1].startsWith('_') &&
						methodMatch[1] !== '__init__',
					signature: `def ${methodMatch[1]}(${methodMatch[2].trim()})${methodMatch[3] ? ` -> ${methodMatch[3].trim()}` : ''}`,
					line: i + 1,
				});
				continue;
			}
		}
		if (line.startsWith(' ') || line.startsWith('\t')) continue; // Skip other nested definitions

		// Functions
		const fnMatch = line.match(
			/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?:/,
		);
		if (fnMatch) {
			const exported = isExplicitlyExported(fnMatch[1]);
			addSymbol({
				name: fnMatch[1],
				kind: 'function',
				exported,
				signature: `def ${fnMatch[1]}(${fnMatch[2].trim()})${fnMatch[3] ? ` -> ${fnMatch[3].trim()}` : ''}`,
				line: i + 1,
			});
		}

		// Classes
		const classMatch = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
		if (classMatch) {
			const exported = isExplicitlyExported(classMatch[1]);
			currentClass = { name: classMatch[1], exported, indent };
			addSymbol({
				name: classMatch[1],
				kind: 'class',
				exported,
				signature: `class ${classMatch[1]}${classMatch[2] ? `(${classMatch[2].trim()})` : ''}`,
				line: i + 1,
			});
		}

		// Module-level constants (UPPER_CASE)
		const constMatch = line.match(/^([A-Z][A-Z0-9_]+)\s*[:=]/);
		if (constMatch) {
			addSymbol({
				name: constMatch[1],
				kind: 'const',
				exported: isExplicitlyExported(constMatch[1]),
				signature: line.trim().substring(0, 100),
				line: i + 1,
			});
		}

		const importMatch = line.match(
			/^from\s+[\w.]+\s+import\s+(.+?)(?:\s*#.*)?$/,
		);
		if (importMatch && (isPackageInit || explicitExports)) {
			for (const rawPart of importMatch[1].split(',')) {
				const part = rawPart.trim();
				if (!part || part === '*') continue;
				const alias = part.match(/^(\w+)\s+as\s+(\w+)$/);
				const importedName = alias ? alias[1] : part;
				const localName = alias ? alias[2] : part;
				if (!/^\w+$/.test(importedName) || !/^\w+$/.test(localName)) continue;
				const exported = isExplicitlyExported(localName);
				if (!exported && explicitExports) continue;
				addSymbol({
					name: localName,
					kind: 'variable',
					exported,
					signature: line.trim().substring(0, 100),
					line: i + 1,
				});
			}
		}
	}

	// Sort by line number for deterministic ordering, with tie-breaker on symbol name
	return symbols.sort((a, b) => {
		if (a.line !== b.line) return a.line - b.line;
		return a.name.localeCompare(b.name);
	});
}

export function extractRustSymbols(
	filePath: string,
	cwd: string,
): SymbolInfo[] {
	const content = readValidatedSourceFile(filePath, cwd);
	if (content === null) return [];

	const symbols: SymbolInfo[] = [];
	const lines = content.split('\n');
	let implDepth = 0;
	const braceDelta = (text: string): number =>
		(text.match(/{/g)?.length ?? 0) - (text.match(/}/g)?.length ?? 0);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const inImpl = implDepth > 0;

		if (!inImpl && /^impl\b/.test(trimmed)) {
			implDepth = Math.max(0, implDepth + braceDelta(trimmed));
			continue;
		}

		if (inImpl) {
			const method = trimmed.match(
				/^(pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
			);
			if (method) {
				const modifier = method[1] ?? '';
				symbols.push({
					name: method[2],
					kind: 'method',
					exported: modifier.trim().startsWith('pub'),
					signature: trimmed.substring(0, 100),
					line: i + 1,
				});
			}
			implDepth = Math.max(0, implDepth + braceDelta(trimmed));
			continue;
		}

		if (/^\s/.test(line)) continue;
		const item = trimmed.match(
			/^(pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/,
		);
		if (!item) continue;
		const modifier = item[1] ?? '';
		const exported = modifier.trim().startsWith('pub');
		const kindMap: Record<string, SymbolInfo['kind']> = {
			fn: 'function',
			struct: 'type',
			enum: 'enum',
			trait: 'interface',
			mod: 'type',
		};
		symbols.push({
			name: item[3],
			kind: kindMap[item[2]] ?? 'type',
			exported,
			signature: trimmed.substring(0, 100),
			line: i + 1,
		});
	}

	return symbols.sort((a, b) => {
		if (a.line !== b.line) return a.line - b.line;
		return a.name.localeCompare(b.name);
	});
}

export function extractGoSymbols(filePath: string, cwd: string): SymbolInfo[] {
	const content = readValidatedSourceFile(filePath, cwd);
	if (content === null) return [];

	const symbols: SymbolInfo[] = [];
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const method = line.match(
			/^func\s+\([^)]*\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
		);
		if (method) {
			symbols.push({
				name: method[1],
				kind: 'method',
				exported: /^[A-Z]/.test(method[1]),
				signature: line.trim().substring(0, 100),
				line: i + 1,
			});
			continue;
		}

		const fn = line.match(/^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
		if (fn) {
			symbols.push({
				name: fn[1],
				kind: 'function',
				exported: /^[A-Z]/.test(fn[1]),
				signature: line.trim().substring(0, 100),
				line: i + 1,
			});
			continue;
		}

		const typeDecl = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (typeDecl) {
			symbols.push({
				name: typeDecl[1],
				kind: 'type',
				exported: /^[A-Z]/.test(typeDecl[1]),
				signature: line.trim().substring(0, 100),
				line: i + 1,
			});
			continue;
		}

		const valueDecl = line.match(/^(var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (valueDecl) {
			symbols.push({
				name: valueDecl[2],
				kind: valueDecl[1] === 'const' ? 'const' : 'variable',
				exported: /^[A-Z]/.test(valueDecl[2]),
				signature: line.trim().substring(0, 100),
				line: i + 1,
			});
		}
	}

	return symbols.sort((a, b) => {
		if (a.line !== b.line) return a.line - b.line;
		return a.name.localeCompare(b.name);
	});
}

// ============ Workspace File Discovery ============

/**
 * Recursively find source files with supported symbol extensions.
 * Skips well-known non-source directories. Caps at maxFiles.
 * All returned paths are relative to the workspace root.
 */
function findSourceFiles(cwd: string, maxFiles: number): string[] {
	const files: string[] = [];
	walkDir(cwd, cwd, files, maxFiles);
	return files;
}

function walkDir(
	currentDir: string,
	rootDir: string,
	files: string[],
	maxFiles: number,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(currentDir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) =>
		a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	);
	for (const entry of entries) {
		if (files.length >= maxFiles) return;
		if (SKIP_DIRECTORIES.has(entry.name)) continue;
		const fullPath = path.join(currentDir, entry.name);
		if (entry.isDirectory()) {
			walkDir(fullPath, rootDir, files, maxFiles);
		} else if (
			entry.isFile() &&
			SYMBOL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
		) {
			files.push(path.relative(rootDir, fullPath));
		}
	}
}

/**
 * Search workspace for symbols across multiple files.
 * Uses a time budget and caps results for safety.
 */
function searchWorkspaceSymbols(
	cwd: string,
	name?: string,
	exportedOnly: boolean = true,
): WorkspaceResult {
	const startTime = Date.now();
	const sourceFiles = findSourceFiles(cwd, MAX_WORKSPACE_SCANNED_FILES);
	const files: WorkspaceFileSummary[] = [];
	let scannedCount = 0;
	let truncated = false;
	if (sourceFiles.length >= MAX_WORKSPACE_SCANNED_FILES) {
		truncated = true;
	}
	let totalSymbols = 0;

	for (const relFile of sourceFiles) {
		// Check timeout
		if (Date.now() - startTime > WORKSPACE_TIMEOUT_MS) {
			truncated = true;
			break;
		}

		scannedCount++;
		let syms: SymbolInfo[];

		const ext = path.extname(relFile).toLowerCase();
		switch (ext) {
			case '.ts':
			case '.tsx':
			case '.js':
			case '.jsx':
			case '.mjs':
			case '.cjs':
				syms = extractTSSymbols(relFile, cwd);
				break;
			case '.py':
			case '.pyw':
				syms = extractPythonSymbols(relFile, cwd);
				break;
			case '.rs':
				syms = extractRustSymbols(relFile, cwd);
				break;
			case '.go':
				syms = extractGoSymbols(relFile, cwd);
				break;
			default:
				continue;
		}

		// Filter by exported-only
		if (exportedOnly) {
			syms = syms.filter((s) => s.exported);
		}

		// Filter by name substring
		if (name) {
			syms = syms.filter((s) => s.name.includes(name));
		}

		if (syms.length > 0) {
			const remaining = MAX_WORKSPACE_RESULTS - totalSymbols;
			if (remaining <= 0) {
				truncated = true;
				break;
			}
			const cappedSyms = syms.slice(0, remaining);
			files.push({
				file: relFile,
				symbolCount: cappedSyms.length,
				symbols: cappedSyms,
			});
			totalSymbols += cappedSyms.length;

			if (totalSymbols >= MAX_WORKSPACE_RESULTS) {
				truncated =
					syms.length > remaining || scannedCount < sourceFiles.length;
				break;
			}
		}
	}

	return {
		query: { workspace: true, name },
		fileCount: files.length,
		scannedFileCount: scannedCount,
		totalSymbols,
		files,
		truncated,
	};
}

// ============ Tool Definition ============

export const symbols: ToolDefinition = createSwarmTool({
	description:
		'Extract all exported symbols from a source file: functions with signatures, ' +
		'classes with public members, interfaces, types, enums, constants. ' +
		'Supports TypeScript/JavaScript, Python, Rust, and Go. Use for architect planning, ' +
		'designer scaffolding, and understanding module public API surface.',
	args: {
		file: z
			.string()
			.optional()
			.describe(
				'File path to extract symbols from (e.g., "src/auth/login.ts"). Required when not using workspace mode.',
			),
		exported_only: z
			.boolean()
			.default(true)
			.describe(
				'If true, only return exported/public symbols. If false, include all top-level symbols.',
			),
		workspace: z
			.boolean()
			.optional()
			.describe(
				'When true, search across the workspace instead of a single file. Returns per-file symbol summaries.',
			),
		name: z
			.string()
			.optional()
			.describe(
				'Search for symbols by name (case-sensitive substring match). When provided without workspace, only searches the specified file.',
			),
	},
	execute: async (args: unknown, directory: string) => {
		// Safe args extraction - prevent crashes from malicious getters
		let file: string | undefined;
		let exportedOnly = true;
		let workspace = false;
		let name: string | undefined;
		try {
			const obj = args as Record<string, unknown>;
			file =
				obj.file != null && typeof obj.file === 'string' ? obj.file : undefined;
			exportedOnly = obj.exported_only !== false;
			workspace = obj.workspace === true;
			name =
				obj.name != null && typeof obj.name === 'string' ? obj.name : undefined;
		} catch {
			return JSON.stringify(
				{
					file: '<unknown>',
					error: 'Invalid arguments: could not extract parameters',
					symbols: [],
				},
				null,
				2,
			);
		}

		const cwd = directory;

		// --- Workspace mode ---
		if (workspace) {
			return JSON.stringify(
				searchWorkspaceSymbols(cwd, name, exportedOnly),
				null,
				2,
			);
		}

		// --- Single-file mode requires file ---
		if (!file) {
			return JSON.stringify(
				{
					error: 'file parameter is required when not using workspace mode',
					symbols: [],
				},
				null,
				2,
			);
		}

		// Validate path contains no control characters
		if (containsControlChars(file)) {
			return JSON.stringify(
				{
					file,
					error: 'Path contains invalid control characters',
					symbols: [],
				},
				null,
				2,
			);
		}

		// Validate path to stay within workspace
		if (containsPathTraversal(file)) {
			return JSON.stringify(
				{
					file,
					error: 'Path contains path traversal sequence',
					symbols: [],
				},
				null,
				2,
			);
		}

		// Check for Windows-specific attacks (ADS streams, reserved device names)
		if (containsWindowsAttacks(file)) {
			return JSON.stringify(
				{
					file,
					error: 'Path contains invalid Windows-specific sequence',
					symbols: [],
				},
				null,
				2,
			);
		}

		if (!isPathInWorkspace(file, cwd)) {
			return JSON.stringify(
				{
					file,
					error: 'Path is outside workspace',
					symbols: [],
				},
				null,
				2,
			);
		}

		const ext = path.extname(file);

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
			case '.pyw':
				syms = extractPythonSymbols(file, cwd);
				break;
			case '.rs':
				syms = extractRustSymbols(file, cwd);
				break;
			case '.go':
				syms = extractGoSymbols(file, cwd);
				break;
			default:
				return JSON.stringify(
					{
						file,
						error: `Unsupported file extension: ${ext}. Supported: .ts, .tsx, .js, .jsx, .mjs, .cjs, .py, .pyw, .rs, .go`,
						symbols: [],
					},
					null,
					2,
				);
		}

		if (exportedOnly) {
			syms = syms.filter((s) => s.exported);
		}

		// Filter by name substring when name is provided for a single file
		if (name) {
			syms = syms.filter((s) => s.name.includes(name));
		}

		return JSON.stringify(
			{
				file,
				symbolCount: syms.length,
				symbols: syms,
			},
			null,
			2,
		);
	},
});
