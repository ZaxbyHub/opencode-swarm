import type { Parser as ParserType } from 'web-tree-sitter';
export type Parser = ParserType;
/**
 * Parser cache to avoid reloading grammars multiple times per session
 */
export declare const parserCache: Map<string, ParserType>;
/**
 * DI seam for testing — overridable reference to TreeSitterParser.init.
 * Tests can replace this with a spy/mock to observe init calls without
 * mock.module leakage. Restore the original reference in afterEach.
 */
export declare const _internals: {
    parserInit: (opts?: {
        locateFile: (scriptName: string) => string;
    }) => Promise<void>;
};
/**
 * Initialize a parser for the given language
 * Loads WASM from dist/lang/grammars/ (copied during build)
 *
 * @param languageId - Language identifier (e.g., 'javascript', 'python')
 * @returns Configured Parser instance
 * @throws Error if WASM file not found or failed to load
 */
export declare function loadGrammar(languageId: string): Promise<ParserType>;
/**
 * Check if a language grammar is available (WASM file exists)
 * Does not load the grammar, just checks existence
 *
 * @param languageId - Language identifier
 * @returns true if grammar is available
 */
export declare function isGrammarAvailable(languageId: string): Promise<boolean>;
/**
 * Clear the parser cache (useful for testing)
 */
export declare function clearParserCache(): void;
/**
 * Get list of initialized languages
 */
export declare function getInitializedLanguages(): string[];
/**
 * Get list of supported language IDs
 */
export declare function getSupportedLanguages(): string[];
