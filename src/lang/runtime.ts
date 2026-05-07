import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Parser as ParserType } from 'web-tree-sitter';
// Note: Language must be imported as both type and value for runtime loading
// TreeSitterParser is imported to use Language.load()
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Language, Parser as TreeSitterParser } from 'web-tree-sitter';

// Re-export Parser type for consumers
export type Parser = ParserType;

/**
 * Parser cache to avoid reloading grammars multiple times per session
 */
export const parserCache = new Map<string, ParserType>();

/**
 * Track which languages have been initialized to avoid re-init
 */
const initializedLanguages = new Set<string>();

/**
 * In-flight or completed init promise. All concurrent callers share this single
 * promise so Parser.init() is called exactly once. Nulled on failure to allow retry.
 */
let treeSitterInitPromise: Promise<void> | null = null;

/**
 * Initialize the tree-sitter WASM runtime
 * Must be called before creating any parsers
 */
async function initTreeSitter(): Promise<void> {
	if (!treeSitterInitPromise) {
		treeSitterInitPromise = (async () => {
			const thisDir = path.dirname(fileURLToPath(import.meta.url));
			const isSource = thisDir.replace(/\\/g, '/').endsWith('/src/lang');

			if (isSource) {
				// In dev, web-tree-sitter's own import.meta.url resolves tree-sitter.wasm
				// correctly from node_modules/web-tree-sitter/
				await TreeSitterParser.init();
			} else {
				// In bundle, import.meta.url points to dist/index.js so web-tree-sitter
				// looks for dist/tree-sitter.wasm — redirect to dist/lang/grammars/
				const grammarsDir = getGrammarsDirAbsolute();
				await TreeSitterParser.init({
					locateFile(scriptName: string) {
						return path.join(grammarsDir, scriptName);
					},
				});
			}
		})().catch((err) => {
			treeSitterInitPromise = null; // allow retry after transient failure
			throw err;
		});
	}
	return treeSitterInitPromise;
}

/**
 * Map of language IDs to WASM file names. Entries from @vscode/tree-sitter-wasm are copied by copy-grammars.ts; kotlin/swift/dart entries are vendored directly in src/lang/grammars/.
 */
const LANGUAGE_WASM_MAP: Record<string, string> = {
	javascript: 'tree-sitter-javascript.wasm',
	typescript: 'tree-sitter-typescript.wasm',
	tsx: 'tree-sitter-tsx.wasm',
	python: 'tree-sitter-python.wasm',
	go: 'tree-sitter-go.wasm',
	rust: 'tree-sitter-rust.wasm',
	cpp: 'tree-sitter-cpp.wasm',
	c: 'tree-sitter-cpp.wasm',
	csharp: 'tree-sitter-c-sharp.wasm',
	css: 'tree-sitter-css.wasm',
	bash: 'tree-sitter-bash.wasm',
	ruby: 'tree-sitter-ruby.wasm',
	php: 'tree-sitter-php.wasm',
	java: 'tree-sitter-java.wasm',
	kotlin: 'tree-sitter-kotlin.wasm',
	swift: 'tree-sitter-swift.wasm',
	dart: 'tree-sitter-dart.wasm',
	powershell: 'tree-sitter-powershell.wasm',
	ini: 'tree-sitter-ini.wasm',
	regex: 'tree-sitter-regex.wasm',
};

/**
 * Sanitize a language ID using a strict whitelist.
 * Only lowercase alphanumeric characters and hyphens are allowed.
 * Throws on invalid input to prevent path traversal and injection.
 */
function sanitizeLanguageId(languageId: string): string {
	const normalized = languageId.toLowerCase();
	if (!/^[a-z0-9-]+$/.test(normalized)) {
		throw new Error(`Invalid language ID: ${languageId}`);
	}
	return normalized;
}

function getWasmFileName(languageId: string): string {
	const sanitized = sanitizeLanguageId(languageId).toLowerCase();
	// Check if there's a direct mapping
	if (LANGUAGE_WASM_MAP[sanitized]) {
		return LANGUAGE_WASM_MAP[sanitized];
	}

	// Fallback: try tree-sitter-{languageId}.wasm
	return `tree-sitter-${sanitized}.wasm`;
}

/**
 * Get the absolute path to the grammars directory.
 * Works in dev (src/lang/runtime.ts) and bundled (dist/index.js) environments,
 * across Windows, macOS, and Linux.
 */
function getGrammarsDirAbsolute(): string {
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	// In dev: thisDir = .../src/lang/ → grammars at src/lang/grammars/
	// In main bundle: thisDir = .../dist/ → grammars at dist/lang/grammars/
	// In CLI bundle: thisDir = .../dist/cli/ → grammars at dist/lang/grammars/
	const normalized = thisDir.replace(/\\/g, '/');
	const isSource = normalized.endsWith('/src/lang');
	const isCliBundle = normalized.endsWith('/cli');
	return isSource
		? path.join(thisDir, 'grammars')
		: isCliBundle
			? path.join(thisDir, '..', 'lang', 'grammars')
			: path.join(thisDir, 'lang', 'grammars');
}

/**
 * Initialize a parser for the given language
 * Loads WASM from dist/lang/grammars/ (copied during build)
 *
 * @param languageId - Language identifier (e.g., 'javascript', 'python')
 * @returns Configured Parser instance
 * @throws Error if WASM file not found or failed to load
 */
export async function loadGrammar(languageId: string): Promise<ParserType> {
	if (typeof languageId !== 'string' || languageId.length > 100) {
		throw new Error(
			`Invalid languageId: must be a string of at most 100 characters`,
		);
	}
	const normalizedId = sanitizeLanguageId(languageId).toLowerCase();
	if (normalizedId.length === 0) {
		throw new Error(`Invalid languageId: empty after sanitization`);
	}

	// Return cached parser if available
	if (parserCache.has(normalizedId)) {
		return parserCache.get(normalizedId)!;
	}

	// Initialize tree-sitter WASM runtime
	await initTreeSitter();

	// Initialize parser
	const parser = new TreeSitterParser();

	// Get WASM file name and construct path
	const wasmFileName = getWasmFileName(normalizedId);
	const wasmPath = path.join(getGrammarsDirAbsolute(), wasmFileName);

	// Check if file exists before attempting to load
	const { existsSync } = await import('node:fs');
	if (!existsSync(wasmPath)) {
		throw new Error(
			`Grammar file not found for ${languageId}: ${wasmPath}\n` +
				`Make sure to run 'bun run build' to copy grammar files to dist/lang/grammars/`,
		);
	}

	try {
		const language = await Language.load(wasmPath);
		parser.setLanguage(language);
	} catch (error) {
		throw new Error(
			`Failed to load grammar for ${languageId}: ${error instanceof Error ? error.message : String(error)}\n` +
				`WASM path: ${wasmPath}`,
		);
	}

	// Cache and return
	parserCache.set(normalizedId, parser);
	initializedLanguages.add(normalizedId);

	return parser;
}

/**
 * Check if a language grammar is available (WASM file exists)
 * Does not load the grammar, just checks existence
 *
 * @param languageId - Language identifier
 * @returns true if grammar is available
 */
export async function isGrammarAvailable(languageId: string): Promise<boolean> {
	if (typeof languageId !== 'string' || languageId.length > 100) {
		return false;
	}
	let normalizedId: string;
	try {
		normalizedId = sanitizeLanguageId(languageId).toLowerCase();
	} catch {
		return false;
	}
	if (normalizedId.length === 0) {
		return false;
	}

	// If already cached, it's available
	if (parserCache.has(normalizedId)) {
		return true;
	}

	// Try to check if WASM file exists
	try {
		const wasmFileName = getWasmFileName(normalizedId);
		const wasmPath = path.join(getGrammarsDirAbsolute(), wasmFileName);

		const { statSync } = await import('node:fs');
		statSync(wasmPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Clear the parser cache (useful for testing)
 */
export function clearParserCache(): void {
	parserCache.clear();
	initializedLanguages.clear();
	treeSitterInitPromise = null;
}

/**
 * Get list of initialized languages
 */
export function getInitializedLanguages(): string[] {
	return Array.from(initializedLanguages);
}

/**
 * Get list of supported language IDs
 */
export function getSupportedLanguages(): string[] {
	return Object.keys(LANGUAGE_WASM_MAP);
}
