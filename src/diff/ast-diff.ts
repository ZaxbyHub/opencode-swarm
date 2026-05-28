import { extname } from 'node:path';
import { Query, type QueryMatch, type Tree } from 'web-tree-sitter';
import {
	getLanguageForExtension,
	type LanguageDefinition,
} from '../lang/registry.js';
import { loadGrammar } from '../lang/runtime.js';

export interface ASTChange {
	type: 'added' | 'modified' | 'removed' | 'renamed';
	category:
		| 'function'
		| 'class'
		| 'type'
		| 'export'
		| 'import'
		| 'variable'
		| 'other';
	name: string;
	lineStart: number;
	lineEnd: number;
	signature?: string; // For functions: parameters; for types: definition
	renamedFrom?: string;
}

export interface ASTDiffResult {
	filePath: string;
	language: string | null;
	changes: ASTChange[];
	durationMs: number;
	usedAST: boolean;
	error?: string;
}

// Query patterns for different node types
const QUERIES: Record<string, string> = {
	// JavaScript/TypeScript
	javascript: `
    (function_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (identifier) @class.name) @class.def
    (export_statement) @export
    (import_statement) @import
    (type_alias_declaration name: (type_identifier) @type.name) @type.def
  `,
	typescript: `
    (function_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (type_identifier) @class.name) @class.def
    (export_statement) @export
    (import_statement) @import
    (type_alias_declaration name: (type_identifier) @type.name) @type.def
    (interface_declaration name: (type_identifier) @interface.name) @interface.def
  `,
	// Python
	python: `
    (function_definition name: (identifier) @func.name) @func.def
    (class_definition name: (identifier) @class.name) @class.def
    (import_statement) @import
    (expression_statement (assignment left: (identifier) @var.name)) @var.def
  `,
	// Go
	go: `
    (function_declaration name: (identifier) @func.name) @func.def
    (type_declaration (type_spec name: (type_identifier) @type.name)) @type.def
    (import_declaration) @import
  `,
	// Rust
	rust: `
    (function_item name: (identifier) @func.name) @func.def
    (struct_item name: (type_identifier) @struct.name) @struct.def
    (impl_item type: (type_identifier) @impl.name) @impl.def
    (use_declaration) @import
  `,
	// Java
	java: `
    (method_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (identifier) @class.name) @class.def
    (interface_declaration name: (identifier) @interface.name) @interface.def
    (import_declaration) @import
  `,
	// C
	c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @func.name)) @func.def
    (struct_specifier name: (type_identifier) @struct.name) @struct.def
    (type_definition declarator: (type_identifier) @type.name) @type.def
    (preproc_include) @import
  `,
	// C++
	cpp: `
    (function_definition declarator: (function_declarator declarator: (identifier) @func.name)) @func.def
    (class_specifier name: (type_identifier) @class.name) @class.def
    (struct_specifier name: (type_identifier) @struct.name) @struct.def
    (preproc_include) @import
  `,
	// C#
	csharp: `
    (method_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (identifier) @class.name) @class.def
    (interface_declaration name: (identifier) @interface.name) @interface.def
    (struct_declaration name: (identifier) @struct.name) @struct.def
    (using_directive) @using
  `,
	// Ruby
	ruby: `
    (method name: (identifier) @func.name) @func.def
    (class name: (constant) @class.name) @class.def
    (module name: (constant) @module.name) @module.def
  `,
	// PHP
	php: `
    (function_definition name: (name) @func.name) @func.def
    (class_declaration name: (name) @class.name) @class.def
    (interface_declaration name: (name) @interface.name) @interface.def
    (namespace_use_declaration) @import
  `,
	// Swift
	swift: `
    (function_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (identifier) @class.name) @class.def
    (struct_declaration name: (identifier) @struct.name) @struct.def
    (protocol_declaration name: (identifier) @protocol.name) @protocol.def
    (import_declaration) @import
  `,
	// Kotlin
	kotlin: `
    (function_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (identifier) @class.name) @class.def
    (object_declaration name: (identifier) @object.name) @object.def
    (import_header) @import
  `,
	// Dart
	dart: `
    (function_signature name: (identifier) @func.name) @func.def
    (class_definition name: (identifier) @class.name) @class.def
    (mixin_declaration name: (identifier) @mixin.name) @mixin.def
    (import_directive) @import
  `,
	// CSS
	css: `
    (rule_set (selectors) @rule.selector) @rule.def
  `,
	// Bash
	bash: `
    (function_definition name: (word) @command.name) @command.def
  `,
	// PowerShell
	powershell: `
    (function_statement (function_name) @func.name) @func.def
  `,
	// TSX (shares TypeScript queries)
	tsx: `
    (function_declaration name: (identifier) @func.name) @func.def
    (class_declaration name: (identifier) @class.name) @class.def
    (export_statement) @export
    (import_statement) @import
    (type_alias_declaration name: (type_identifier) @type.name) @type.def
    (interface_declaration name: (type_identifier) @interface.name) @interface.def
  `,
};

// Timeout for AST operations (prevent hanging on large files)
const AST_TIMEOUT_MS = 500;

/**
 * Compute AST-level diff between old and new file content
 */
export async function computeASTDiff(
	filePath: string,
	oldContent: string,
	newContent: string,
): Promise<ASTDiffResult> {
	const startTime = Date.now();
	const extension = extname(filePath).toLowerCase();
	const language = getLanguageForExtension(extension);

	// If no language support, fall back to raw diff
	if (!language) {
		return {
			filePath,
			language: null,
			changes: [],
			durationMs: Date.now() - startTime,
			usedAST: false,
		};
	}

	try {
		// Load parser with timeout
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const parser = await Promise.race([
			loadGrammar(language.id),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error('AST_TIMEOUT')),
					AST_TIMEOUT_MS,
				);
			}),
		]).finally(() => {
			if (timeoutId) clearTimeout(timeoutId);
		});

		// Parse both versions
		const oldTree = parser.parse(oldContent);
		const newTree = parser.parse(newContent);

		// Handle null trees (parse failure)
		if (!oldTree || !newTree) {
			return {
				filePath,
				language: language.id,
				changes: [],
				durationMs: Date.now() - startTime,
				usedAST: false,
				error: 'Failed to parse file',
			};
		}

		// Extract symbols from both trees
		const oldSymbols = extractSymbols(oldTree, language);
		const newSymbols = extractSymbols(newTree, language);

		// Compare and generate changes
		const changes = compareSymbols(oldSymbols, newSymbols);

		// Cleanup
		oldTree.delete();
		newTree.delete();

		return {
			filePath,
			language: language.id,
			changes,
			durationMs: Date.now() - startTime,
			usedAST: true,
		};
	} catch (error) {
		// On timeout or error, fall back to raw diff
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		if (errorMsg === 'AST_TIMEOUT') {
			console.warn(
				`[ast-diff] Timeout for ${filePath}, falling back to raw diff`,
			);
		}

		return {
			filePath,
			language: language.id,
			changes: [],
			durationMs: Date.now() - startTime,
			usedAST: false,
			error: errorMsg,
		};
	}
}

interface SymbolInfo {
	category: ASTChange['category'];
	name: string;
	lineStart: number;
	lineEnd: number;
	signature?: string;
}

function extractSymbols(
	tree: Tree,
	language: LanguageDefinition,
): SymbolInfo[] {
	const symbols: SymbolInfo[] = [];
	const queryStr = QUERIES[language.id];

	if (!queryStr) {
		return symbols;
	}

	try {
		// Get language from tree - the parser sets the language on the tree
		const lang = tree.language;
		if (!lang) {
			return symbols;
		}

		const query = new Query(lang, queryStr);
		const matches = query.matches(tree.rootNode);

		for (const match of matches) {
			const symbol = parseMatch(match, language.id);
			if (symbol) {
				symbols.push(symbol);
			}
		}

		// Deduplicate: prefer definition captures (.def) over bare export/import captures.
		// When both match the same code (e.g., "export function foo()" produces both
		// @func.def and @export), keep the definition and discard the export/import duplicate.
		// Use exact span match — real duplicates from tree-sitter always have the same
		// start/end line because the export_statement node wraps the function_declaration node.
		// Known limitation: same-line sibling statements (e.g., "function foo(){}; export {foo}")
		// may be falsely deduplicated. Acceptable tradeoff — definitions are preserved.
		const defEntries = symbols.filter(
			(s) => s.category !== 'export' && s.category !== 'import',
		);
		if (defEntries.length > 0 && defEntries.length < symbols.length) {
			const filtered = symbols.filter((symbol) => {
				if (symbol.category !== 'export' && symbol.category !== 'import') {
					return true;
				}
				// Only remove if an exact span match exists (same start and end line)
				const isDuplicate = defEntries.some(
					(def) =>
						symbol.lineStart === def.lineStart &&
						symbol.lineEnd === def.lineEnd,
				);
				return !isDuplicate;
			});
			symbols.length = 0;
			symbols.push(...filtered);
		}
	} catch {
		// Query failed, return empty
	}

	return symbols;
}

function parseMatch(match: QueryMatch, languageId: string): SymbolInfo | null {
	// Extract symbol info from query match
	const captures = match.captures;

	// Find the definition capture (ends with .def)
	const defCapture = captures.find((c) => c.name.endsWith('.def'));
	const nameCapture = captures.find((c) => c.name.endsWith('.name'));

	if (!defCapture) {
		// Handle captures without .def suffix (export/import statements)
		const exportCapture = captures.find((c) => c.name === 'export');
		const importCapture = captures.find((c) => c.name === 'import');

		const categoryCapture = exportCapture || importCapture;
		if (!categoryCapture) return null;

		const node = categoryCapture.node;
		const text = node.text.trim();
		const name = extractStatementName(text, categoryCapture.name);

		return {
			category: categoryCapture.name === 'export' ? 'export' : 'import',
			name,
			lineStart: node.startPosition.row + 1,
			lineEnd: node.endPosition.row + 1,
		};
	}

	const node = defCapture.node;
	const nameNode = nameCapture?.node;

	return {
		category: inferCategory(captures[0]?.name || 'other'),
		name: nameNode?.text || 'anonymous',
		lineStart: node.startPosition.row + 1,
		lineEnd: node.endPosition.row + 1,
		signature: extractSignature(node, languageId),
	};
}

function extractStatementName(text: string, captureType: string): string {
	if (captureType === 'import') {
		const fromMatch = text.match(/from\s+['"]([^'"]+)['"]/);
		if (fromMatch) return fromMatch[1];
		const stringMatch = text.match(/['"]([^'"]+)['"]/);
		if (stringMatch) return stringMatch[1];
	} else {
		const namedExport = text.match(
			/export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface)\s+(\w+)/,
		);
		if (namedExport) return namedExport[1];
		// Handle anonymous default exports: export default function() or export default class {}
		const anonymousDefault = text.match(
			/export\s+default\s+(?:function|class)\b/,
		);
		if (anonymousDefault) return 'default';
		const braceExport = text.match(/export\s+\{([^}]+)\}/);
		if (braceExport) return braceExport[1].trim();
	}
	const tokens = text.split(/\s+/);
	return tokens.length > 1 ? tokens.slice(0, 3).join(' ') : text.slice(0, 30);
}

function inferCategory(captureName: string): ASTChange['category'] {
	if (captureName.includes('func')) return 'function';
	if (captureName.includes('class')) return 'class';
	if (
		captureName.includes('type') ||
		captureName.includes('interface') ||
		captureName.includes('struct') ||
		captureName.includes('protocol') ||
		captureName.includes('mixin') ||
		captureName.includes('object') ||
		captureName.includes('module')
	)
		return 'type';
	if (captureName.includes('export')) return 'export';
	if (
		captureName.includes('import') ||
		captureName.includes('use') ||
		captureName.includes('using')
	)
		return 'import';
	if (captureName.includes('var')) return 'variable';
	if (captureName.includes('command')) return 'function';
	if (captureName.includes('rule')) return 'type';
	return 'other';
}

// Minimal interface for tree-sitter syntax node
interface SyntaxNodeRef {
	type: string;
	text: string;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	children: (SyntaxNodeRef | null)[];
}

// Map of language -> parameter node type names
const paramNodeTypes: Record<string, string[]> = {
	javascript: ['formal_parameters'],
	typescript: ['formal_parameters'],
	tsx: ['formal_parameters'],
	python: ['parameters'],
	go: ['parameter_list'],
	rust: ['parameters', 'function_item'],
	java: ['formal_parameters', 'method_declaration'],
	c: ['parameter_list'],
	cpp: ['parameter_list'],
	csharp: ['formal_parameters'],
	ruby: ['parameters'],
	php: ['formal_parameters', 'parameter_list'],
	swift: ['parameter_clause'],
	kotlin: ['parameter_list'],
	dart: ['parameter_list', 'function_signature'],
	css: [],
	bash: ['command_position'],
	powershell: ['parameter_list'],
};

function extractSignature(
	node: SyntaxNodeRef,
	languageId: string,
): string | undefined {
	// Extract function signature or type definition
	const nodeTypes = paramNodeTypes[languageId] || [];

	// First try to find parameter node from the node's children
	for (const child of node.children) {
		if (child && nodeTypes.includes(child.type)) {
			return child.text;
		}
	}

	// For JS/TS, also check for formal_parameters specifically
	if (
		languageId === 'javascript' ||
		languageId === 'typescript' ||
		languageId === 'tsx'
	) {
		const paramsNode = node.children.find(
			(c): c is SyntaxNodeRef => c !== null && c.type === 'formal_parameters',
		);
		if (paramsNode) {
			return paramsNode.text;
		}
	}

	// Class rename support: capture class shape without class identifier.
	// This allows class rename detection to compare declarations structurally.
	if (
		node.type === 'class_declaration' ||
		node.type === 'class_definition' ||
		node.type === 'class'
	) {
		const classBodyNode = node.children.find(
			(c): c is SyntaxNodeRef =>
				c !== null &&
				(c.type === 'class_body' || c.type === 'declaration_list'),
		);
		if (classBodyNode) {
			return classBodyNode.text;
		}
	}

	return undefined;
}

function compareSymbols(
	oldSymbols: SymbolInfo[],
	newSymbols: SymbolInfo[],
): ASTChange[] {
	const changes: ASTChange[] = [];
	const oldMap = new Map(oldSymbols.map((s) => [s.name, s]));
	const newMap = new Map(newSymbols.map((s) => [s.name, s]));

	// Track which old symbols have been matched (for rename detection)
	const matchedOldSymbols = new Set<SymbolInfo>();

	// Find added symbols and detect renames
	for (const newSymbol of newSymbols) {
		if (!oldMap.has(newSymbol.name)) {
			// Check if this is a renamed symbol by looking for similar signatures
			const matchingOldSymbol = findRenamedSymbol(
				newSymbol,
				oldSymbols,
				matchedOldSymbols,
			);
			if (matchingOldSymbol) {
				changes.push({
					type: 'renamed',
					category: newSymbol.category,
					name: newSymbol.name,
					lineStart: newSymbol.lineStart,
					lineEnd: newSymbol.lineEnd,
					signature: newSymbol.signature,
					renamedFrom: matchingOldSymbol.name,
				});
				matchedOldSymbols.add(matchingOldSymbol);
			} else {
				changes.push({
					type: 'added',
					category: newSymbol.category,
					name: newSymbol.name,
					lineStart: newSymbol.lineStart,
					lineEnd: newSymbol.lineEnd,
					signature: newSymbol.signature,
				});
			}
		} else {
			// Check for modifications
			const oldSymbol = oldMap.get(newSymbol.name)!;
			matchedOldSymbols.add(oldSymbol);
			if (
				oldSymbol.lineStart !== newSymbol.lineStart ||
				oldSymbol.lineEnd !== newSymbol.lineEnd ||
				oldSymbol.signature !== newSymbol.signature
			) {
				changes.push({
					type: 'modified',
					category: newSymbol.category,
					name: newSymbol.name,
					lineStart: newSymbol.lineStart,
					lineEnd: newSymbol.lineEnd,
					signature: newSymbol.signature,
				});
			}
		}
	}

	// Find removed symbols (that weren't matched as renames)
	for (const oldSymbol of oldSymbols) {
		if (!newMap.has(oldSymbol.name) && !matchedOldSymbols.has(oldSymbol)) {
			changes.push({
				type: 'removed',
				category: oldSymbol.category,
				name: oldSymbol.name,
				lineStart: oldSymbol.lineStart,
				lineEnd: oldSymbol.lineEnd,
				signature: oldSymbol.signature,
			});
		}
	}

	return changes;
}

/**
 * Find a renamed symbol by comparing signatures and line counts
 * Uses conservative thresholds: exact signature match + 20% line tolerance + same category
 */
function findRenamedSymbol(
	newSymbol: SymbolInfo,
	oldSymbols: SymbolInfo[],
	matchedOldSymbols: Set<SymbolInfo>,
): SymbolInfo | null {
	// Only detect renames for functions, types, and classes (not imports/exports)
	if (
		newSymbol.category !== 'function' &&
		newSymbol.category !== 'type' &&
		newSymbol.category !== 'class'
	) {
		return null;
	}

	// Signature must match exactly for rename detection
	if (!newSymbol.signature) {
		return null;
	}

	// For functions, a signature of just "()" is too trivial to be meaningful
	// for rename detection — functions with no parameters are indistinguishable.
	if (
		newSymbol.category === 'function' &&
		newSymbol.signature.replace(/\s/g, '') === '()'
	) {
		return null;
	}

	const lineCount = newSymbol.lineEnd - newSymbol.lineStart;

	for (const oldSymbol of oldSymbols) {
		// Skip if already matched or different category
		if (
			matchedOldSymbols.has(oldSymbol) ||
			oldSymbol.category !== newSymbol.category
		) {
			continue;
		}

		// Signature must match
		if (oldSymbol.signature !== newSymbol.signature) {
			continue;
		}

		// Line count must be within 20% tolerance
		const oldLineCount = oldSymbol.lineEnd - oldSymbol.lineStart;
		const maxAllowedLines = Math.ceil(lineCount * 1.2);
		if (oldLineCount > maxAllowedLines) {
			continue;
		}

		return oldSymbol;
	}

	return null;
}
